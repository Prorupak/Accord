# Accord AI orchestration (Phase 03-II)

How the browser runs a semantic-suggestion pass against `POST /api/suggest`. The goal is that an
unreliable external model can only ever add **reviewable, verified proposals** to a deterministic
application. It never adds accepted pairs and never adds stale or unverifiable data.

Code: `web/src/analysis/`. It builds on the domain engine (`docs/domain-engine.md`) and the workflow
reducer (`docs/workflow-state.md`).

## 1. Architecture

| Layer | Owns | Files |
| --- | --- | --- |
| Domain engine | Eligibility, candidates, the AI-context projection, proposal intake (`addProposals`/`proposalDefect`), invariants, replay | `web/src/domain/` (`aiContext.ts` is new) |
| Workflow reducer | The single authoritative state: active run, generation, configuration, analysis accounting | `web/src/workflow/` |
| Orchestrator | Side effects: request building, transport, response validation, scheduling, deadline, cancellation, model-run metadata | `web/src/analysis/{contract,request,response,runner}.ts` |
| React adapter | Starts a committed run once; cancel; exposes status, metadata and failures | `web/src/analysis/useSuggestAnalysis.ts` |
| FastAPI | Credentials, inference, server limits, schema verification, the provider retry/repair budget | `api/` (unchanged) |

Data path for one batch:

```text
reducer state ──buildSuggestRequest──▶ frozen {request, body}
      ▲                                       │ transport (one request in flight)
      │                                       ▼
 analysis/batchReceived ◀──readSuggestResponse(frozen request, HTTP result)
 (reducer → addProposals → proposalDefect, against current state)
```

Each layer validates on its own and none of them skips the next one's checks. The orchestrator
never calls `applyDecision` and never writes pairs. Proposals reach state only through
`analysis/batchReceived` → `addProposals`.

## 2. Contracts

`contract.ts` mirrors `api/app/schemas.py` exactly, using Zod `strictObject` (unknown keys are
rejected):

- **Request:** `{requestId, generation, configurationHash, rows: [{left: {rowId, fields}, candidates: [{rowId, fields}]}]}`. A field is `{side, rowId, columnId, value}`. Limits: 1–5 rows, 1–5 candidates, 1–6 fields per owner, IDs ≤128 and values ≤2048 **code points**, because Python `len` counts code points and Zod `.max` counts UTF-16 units.
- **Response:** `{requestId, generation, configurationHash, proposals: [...], meta}`.
  - Each proposal: `{leftId, rightId|null, outcome, reasonCode, evidence ≤6, explanation ≤240 code points, generation, configurationHash}`.
  - `meta`: `{provider, model, promptVersion: int, durationMs, attempts, usage: {inputTokens|null, outputTokens|null} | null}`.
- **Error envelope (§8.3):** `{error: {code, message, retryable, requestId, retryAfterSeconds?}}`.

**Drift detection.** Both stacks check the same fixtures in `fixtures/contracts/suggest/`:

- **`api/tests/test_contract_fixtures.py`:**
  - Validates the request with Pydantic.
  - Round-trips the response and requires `model_dump == fixture`, so an added or removed field fails.
  - Runs `verify_suggestions`.
  - Pushes the request through the real route with a mocked provider.
  - Compares error envelopes built by `error_response`.
  - Compares the limit constants.
- **`web/src/analysis/contract.test.ts`:** parses the same files with the Zod schemas, runs `readSuggestResponse` on the request and response pair, and compares the limit constants.

No code generation.

## 3. Request building and context projection

`buildSuggestRequest(rec, rowIds, requestId)` is pure:

- Each row sends `contextFields(left)` and up to five `candidatesFor(rec, left)` rows with their `contextFields`.
- `contextFields` returns only the mapped **name** and, when it is mapped and nonblank, the mapped **product ID**. Each comes with its real row ID and column ID.
- Quantities, units, unmapped columns, decisions and other rows are never read.
- `generation` and `configurationHash` come from the current reconciliation state, and each request gets a fresh `requestId` (UUID).
- The request is self-checked against the Zod request schema, so a construction bug gives `INVALID_REQUEST` and nothing is sent.
- The body is the exact `JSON.stringify` output that will be sent. Its size is measured with `TextEncoder` (UTF-8 bytes, not string length) against the server's 64 KiB cap. An over-limit body is refused before transport as `PAYLOAD_TOO_LARGE` (batch scope).
- The built request is deep-frozen. The response is validated against this exact object.

**Projection policy (spec §7.4)**, in `web/src/domain/aiContext.ts`:

- **Limit.** Outbound values are at most **160 Unicode code points**: the first 160, via `Array.from`. This never splits a surrogate pair.
- **Why code points.** Grapheme clusters were rejected because segmentation depends on the engine's Unicode data, which would make replay engine-dependent.
- **Originals untouched.** The projection is a pure prefix of the original cell. Source cells, the dataset and exports are never modified. The full cell stays available through the dataset.
- **Truncation is derived,** not stored: `projectContext(cell) !== cell`. The wire and audit `EvidenceRef` shapes therefore did not change.
- **Intake check.** Intake (`proposalDefect`) requires each evidence value to equal `projectContext(original cell)`. That is the exact value the model was shown, and it equals the full cell whenever no clipping happened. Citing the hidden full text of a clipped cell is rejected. The audit therefore records what the model actually observed, and replay applies the same function.
- **Fail closed.** A `suggest` is dropped as `truncated_context` when the name or product ID of the left row or the chosen candidate was clipped, because hidden text could change product identity. The row counts as failed ("Could not produce a verified suggestion") and manual review stays available. Abstentions over clipped text are kept.

## 4. Candidate selection and no-candidate rows

`analysis/started` selects up to 20 rows from `analysisEligibleRows`, which contains only
unmatched Source A rows with at least one candidate. **No row starts a run without candidates.**
A row can lose them only during a run, when a human pairs it or pairs or rejects every one of
its candidates.

The policy:

- Before each batch, the runner keeps only selected rows that still have `candidatesFor(...) > 0`, using the current state. Rows without candidates are not sent, so no inference call is spent on them, and they are not counted as analyzed or failed.
- `analysis/completed` treats a selected row as unprocessed only if it **still has candidates**. A run whose only unsent rows lost their candidates therefore ends `complete` rather than `partial`. This is a reducer change.
- `unresolvedReason` now checks `no_candidates` *before* the run-level `analysis_cancelled` / "run failed before reaching it" reasons, so such a row always reads `no_candidates` (domain change).
- The selected set never changes and the 20-row cap is never exceeded. Batches are static chunks of five from `selectedRowIds`, at most four, and a chunk whose rows all dropped out sends nothing.
- A run where no row has candidates cannot start at all: the reducer returns `missing_prerequisite`.

## 5. Response validation

`readSuggestResponse(frozenRequest, {status, body})` runs these checks in order. The first one that fails decides the result:

1. **Status.** A non-200 response must be a valid §8.3 envelope with a code and status that belong together:
   - `INVALID_INPUT`: 400, 403 or 415
   - `PAYLOAD_TOO_LARGE`: 413
   - `BUSY`: 409
   - `NOT_CONFIGURED`: 503
   - `RATE_LIMITED`: 429
   - `MODEL_INVALID_OUTPUT`: 502
   - `UPSTREAM_ERROR`: 500 or 502
   - `TIMEOUT`: 504

   The envelope's `requestId` must echo ours, or be `""` when the server rejected the body before it could read one.
2. **JSON.** The body must parse as JSON. Otherwise the result is `MALFORMED_RESPONSE`.
3. **Schema.** The response must pass the strict Zod schema. Otherwise the result is `CONTRACT_MISMATCH`.
4. **Echoes.** `requestId`, `generation` and `configurationHash` must match exactly, on the envelope and on every proposal. Otherwise the result is `CONTRACT_MISMATCH`.
5. **Model content.** Any failure here gives `MODEL_INVALID_OUTPUT` (batch scope):
   - exactly one result per requested Source A row, with no duplicates or invented IDs
   - a `suggest` names a candidate sent for that row and uses `semantic_equivalence`
   - an `abstain` has `rightId: null` and a non-`semantic_equivalence` reason
   - each evidence `(side, rowId, columnId, value)` is a field this request supplied for this row, with an exactly equal value
   - a suggestion cites only its own two rows, and both of them; an abstention may cite any candidate it was shown
6. **Normalization.** The result becomes a `ProposalBatch` of `IncomingProposal`s in request order.

Malformed model text is never repaired in the browser; schema repair is the server's job. A
failing batch is rejected as a whole and is never partially accepted. The reducer then
re-validates against **current** state through `addProposals`.

## 6. Run lifecycle and scheduling

`startSuggestRun(run, {getState, dispatch}, deps)` executes **one committed run**:

```text
for each chunk of ≤5 selected rows (≤4 chunks):
  stop if cancelled / run no longer current / deadline reached
  rows ← chunk ∩ rows that still have candidates      (skip chunk if empty)
  build + freeze request (current generation/hash, new requestId)
  send exactly one request (shared AbortController)    — one in flight, ever
  validate against the frozen request
  stop if cancelled / run no longer current             (late result dropped)
  dispatch analysis/batchReceived {batch, rowIds}  or  analysis/batchFailed {rowIds}
  run-scope failure → analysis/failed;  deadline → analysis/completed (partial)
dispatch analysis/completed
```

- **Limits:** five rows and five candidates per request, 20 rows and four requests per pass, a four-minute run deadline (`runDeadlineMs`, default 240 000), and one request in flight. The server keeps its own 45 s request deadline, its retries and its single schema repair. The browser adds **no** retries.
- **Deadline.** When the four minutes run out, the in-flight request is aborted and its rows go to `batchFailed`. Then `analysis/completed` settles the run as `partial`. Earlier batches are kept.
- **Starting.** `useSuggestAnalysis.start()` only dispatches `analysis/started`. An effect keyed on the committed `activeRun` (`generation:configurationHash`) starts the runner, and only when no execution exists for that key.
  - The runner never assumes `dispatch` updated state synchronously.
  - `getState` reads the latest committed state; it may lag the runner's own last dispatch, which only affects advisory checks.
  - The reducer remains the final guard.
- **Duplicate prevention:**
  - A `pendingStart` flag and the `activeRun` check absorb double clicks before the commit.
  - The run key holds the execution in a ref, which covers rerenders and Strict Mode's double effects.
  - Unmount cancels.
  - All of this is exercised under `<StrictMode>` in `useSuggestAnalysis.test.tsx`.

## 7. Cancellation

`execution.cancel()` is idempotent. It:

1. Sets a local flag.
2. Aborts the shared `AbortController`.
3. Dispatches `analysis/cancelled` with the run's own `RunRef`. The reducer ignores this if the run already ended.

Where cancellation can land, and what happens:

| When | Effect |
| --- | --- |
| Before the run commits (`start(); cancel()` in one handler) | Remembered; the effect cancels the run as soon as it commits; nothing is sent |
| Preparing a request | The signal is already aborted, so the transport is never called |
| During the fetch | Fetch aborted; a response that arrives anyway is dropped |
| While reading or validating the body | The post-response check sees the flag; nothing is dispatched |
| Between batches | No further scheduling |
| Racing a completed response | Cancel wins if it lands before the continuation runs; otherwise the run completed first and cancel is a no-op |
| Reconfiguration or source replaced | The run disappears from state; the hook cancels the execution and the late result is dropped |
| Unmount | Same as cancel |

Validated earlier batches, human decisions and proposals are kept. The run ends `cancelled`, and
unsent rows read `analysis_cancelled` (or `no_candidates`). Export remains available. Aborting a
request does **not** guarantee the provider stopped or stopped billing (§8.2). The reducer's
generation change on every terminal transition is the final protection against late events.

## 8. Errors and retry policy

`AnalysisFailure = {code, scope, retryable, retryAfterSeconds, requestId, rowIds, message}`. `message` is fixed client text; server, provider and cell text are never forwarded.

| Code | Source | Scope | Retryable |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | Client self-check, or server 400/403/415 | run | no |
| `PAYLOAD_TOO_LARGE` | Client byte check, or server 413 | batch | no |
| `BUSY` | 409 | run | server flag (true) |
| `NOT_CONFIGURED` | 503 | run | server flag (false) |
| `RATE_LIMITED` | 429 (+ `retryAfterSeconds`) | run | server flag |
| `MODEL_INVALID_OUTPUT` | Server 502, or client content checks | batch | no |
| `UPSTREAM_ERROR` | 500/502 | run | server flag |
| `SERVER_TIMEOUT` | 504 | run | server flag |
| `NETWORK` | Fetch threw (not aborted) | run | yes |
| `MALFORMED_RESPONSE` | Body is not JSON | run | no |
| `CONTRACT_MISMATCH` | Wrong envelope, schema, echo or code/status pairing | run | no |
| `CLIENT_DEADLINE` | 4-minute run deadline | run (settles `partial`) | yes |
| `CANCELLED` | User or teardown | n/a | n/a |

What happens for each scope:

- **Batch scope:** `batchFailed(rowIds)`, then the run continues to the next chunk.
- **Run scope:** `batchFailed(rowIds)`, then `analysis/failed {message}`. Rows the run never reached stay unprocessed and read `analysis_failed` ("Analysis stopped before this record was reviewed").

Missing responses never count as analysis, and no abstention is ever invented to cover a
failure. "Retryable" only means a later, **explicit** user retry may succeed. That retry starts
a new run with a new generation; nothing is retried automatically.

## 9. Model-run metadata

There is one `ModelRun` (the existing audit type in `exportSnapshot.ts`) for every request
actually sent. A request refused before transport gets none.

| Field | Value |
| --- | --- |
| `requestId` | the request's UUID |
| `provider`, `model` | `meta` as reported by the server (the model ID the provider actually reported); `""` when the server returned no metadata (error envelope, network failure, abort) |
| `promptVersion` | `String(meta.promptVersion)` (an int on the wire, a string in the audit); `""` when not reported |
| `durationMs` | Client-measured wall time from send to settle (injected clock) |
| `inputTokens`, `outputTokens` | From `meta.usage` only, nullable; never estimated |
| `result` | `valid` (the response passed client validation), `failed`, or `cancelled` (cancelled or superseded before the result could be applied) |

`valid` describes the HTTP result, not domain retention. A valid response whose suggestion the
domain drops (for example, `truncated_context`) is still `valid`. That row is counted failed in
the analysis record.

Records are kept in hook state (`useState`), tagged with their configuration hash, and
`modelRuns` exposes only those for the current configuration. They are not in the reducer and
not in domain state. Nothing logs product text, identifiers, prompts or keys.

## 10. Invariants

- Model output never creates or changes accepted pairs, decisions or exclusions.
- Proposals are applied only through `analysis/batchReceived` → `addProposals`, checked against both the frozen request and the current state.
- Only one request is in flight; there are at most 4 requests and 20 rows per pass.
- A request cannot be built without candidates, and a candidate never comes from anywhere except `candidatesFor`.
- No stale (earlier generation or configuration) or cancelled result changes state.
- A human decision made mid-flight wins:
  - an accepted row's proposal becomes `unavailable`
  - a rejected pair's proposal stays `rejected`
  - pending counts reflect this
  - invariants hold (tested)
- Partial results survive every failure mode, and `prepareExport` → `replayAudit` succeeds after cancellation and with clipped evidence.

## 11. Tests

All deterministic: a controllable fake transport (`analysis/testkit.ts`) and the **real**
`workflowReducer`.

- **The fake transport** captures every request, and each call can be resolved or rejected by hand or left pending forever. It can honor or ignore abort and measures concurrency.
- **`request.test.ts`:** projection and surrogate pairs, the field whitelist (no `c2` and no quantity values), product-ID inclusion, the five-row cap, candidate-less rows, UTF-8 byte measurement against a limit the string length would pass, and clipping.
- **`response.test.ts`:** every validation step; each status and code pair, including `retryAfterSeconds`; inconsistent envelopes; null usage.
- **`runner.test.ts`:**
  - **Runs:** the canonical run; 1, 5, 6, 12, 20 and 23 rows (sequential, at most four requests, the 20-row cap, `analysis_limit`); no quantity leakage; replay idempotency.
  - **Failures:** a provider failure after a good batch; a batch-scoped invalid output followed by `partial`; a substantively invalid 200; BUSY, RATE_LIMITED, NOT_CONFIGURED and malformed responses without retries; network failure; client deadline (fake timers).
  - **Cancellation:** during the fetch with a late response, during preparation, immediately, between batches, racing a completed response, and after completion.
  - **Staleness and human decisions:** reconfiguration mid-flight; accept and reject while in flight; human resolution that leaves rows candidate-less; two runs close together.
  - **Clipping:** clipped evidence through audit replay, and the truncated-identity fail-closed rule.
- **`useSuggestAnalysis.test.tsx`** (jsdom, `<StrictMode>`): nothing starts on mount; one execution per run; double `start`; cancel with a late response, then restart; cancel before commit; unmount aborts; typed failures.
- **Regressions:**
  - `reconcile.test.ts`: clipped-evidence intake, abstention evidence, `truncated_context`, `no_candidates` ordering.
  - `analysis.test.ts`: `complete` vs `partial` accounting.
- **Contracts:** `contract.test.ts` plus `api/tests/test_contract_fixtures.py`.

## 12. Known limitations

- **Advisory pre-checks may see slightly old state.** `getState` returns the last committed React state, so the runner's own most recent dispatch may not be visible yet. Only advisory pre-checks (row skipping, early stop) are affected; the reducer re-validates every event.
- **No re-packing of batches.** Batches are static chunks of five, so when rows drop out mid-run a later request can be smaller than five.
- **Clipping counts code points.** It can separate a combining mark from its base character, but the value is still an exact, verifiable prefix.
- **The model is not told a value was clipped.** The fail-closed rule protects identity; the backend prompt is unchanged.
- **Metadata on failure.** A failed request has no provider or model metadata (the server sends none with errors), so those fields are `""`.
- **Unreachable API through the dev proxy.** An unreachable API behind the Next dev proxy may show up as a non-JSON 500, which is classified `MALFORMED_RESPONSE` rather than `NETWORK`.

## 13. Phase 03-III integration contract

```ts
const workflow = useAccordWorkflow();
const ai = useSuggestAnalysis(workflow); // options: { transport?, newId?, now?, runDeadlineMs? } for tests
ai.canStart      // boolean: confirmed, not running, some eligible row
ai.start()       // explicit user intent only; returns false if ignored
ai.cancel()      // idempotent
ai.status        // TaskStatus from the reducer
ai.progress      // { selected, analyzed, failed }
ai.failures      // AnalysisFailure[] for the latest run (show message; offer retry if retryable)
ai.modelRuns     // ModelRun[] for the current configuration → prepareExport(rec, { ..., modelRuns })
```

- Review screens read proposals, statuses and reasons from `workflow.state` and the selectors, as before. Accept and reject go through `workflow.decide(...)` and work while a run is active.
- `workflow.state.error` carries the `analysis_failed` message for a failed run.
- Export waits for `!running` (`canExport`) and passes `ai.modelRuns` in `ExportMeta.modelRuns`.
- Do not call `/api/suggest` from anywhere else, and do not dispatch `analysis/*` events directly.

## 14. Mapping drafts (`/api/map`, Phase 03-III)

`web/src/analysis/mapSuggestion.ts` is a small one-shot client, not a second orchestrator.

- **Request.** `buildMapRequest` sends each side's column IDs and headers and its first five
  records (real row IDs, cells as parsed), plus a `requestId` (UUID) and a per-screen
  `generation` counter.
- **Response.** A strict Zod mirror of `MapResponse`. The `requestId` and `generation` echoes
  must match. Every proposed column must exist on its side and be used at most once, otherwise
  the result is `MODEL_INVALID_OUTPUT`.
- **Errors.** Non-200 envelopes go through the same `readApiError` as `/api/suggest`, so the
  messages are the fixed client texts from `contract.ts`. Network failure is `NETWORK`. There is
  no retry.
- **Use.** The mapping screen shows the result next to each field. It writes to the draft only
  when the user clicks "Apply suggested draft", and it never confirms. A result requested for
  other files is ignored. A failure leaves the draft untouched.
