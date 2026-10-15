# Accord domain engine

The deterministic reconciliation layer lives in `web/src/domain/`. It is plain TypeScript with no
React, network, FastAPI or model dependency. Section numbers (`§N`) refer to
`accord-implementation-spec.md`.

**The engine decides what is accepted. The model only advises.** Every accepted pair passes the
same eligibility policy no matter where it came from.

## Data flow

```text
file bytes ──parseDataset──▶ Dataset (frozen; sha256 id)
                                 │
DraftConfiguration ──validateConfiguration──▶ Configuration ──configurationHash──▶ hash
                                 │
                     buildContext(datasets, config, hash)  →  ReconciliationContext (immutable)
                                 │
                     initializeState(ctx)                  →  ReconciliationState (exact-ID pairs)
                                 │
  addProposals(state, /api/suggest batch) ─┐
  applyDecision(state, UserDecision) ──────┼─▶ new ReconciliationState (revision + 1)
  recordAnalysis(...) ─────────────────────┘
                                 │
                     prepareExport(state, meta) → checkInvariants → matches.csv, unresolved.csv, audit.json
                                 │
                     replayAudit(audit.json)    → same canonical rows, no model
```

| Module | Role |
| --- | --- |
| `types.ts` | §6 contracts, policy versions, §2.1 limits |
| `identity.ts` | SHA-256 (Web Crypto), row IDs, ID normalization, case folding |
| `parseCsv.ts` | Strict CSV ingestion (§4.1) |
| `mapping.ts` | Mapping validation and the configuration hash (§3.2, §4.2) |
| `eligibility.ts` | Context, duplicate-ID quarantine, and `checkPair`, the only eligibility policy |
| `candidates.ts` | Lexical retrieval (§4.4) and the manual-picker row set |
| `quantity.ts` | Decimal parsing, BigInt arithmetic, unit rules (§4.6) |
| `reconcile.ts` | State, exact matching, decisions, proposal intake, selectors, unresolved reasons |
| `invariants.ts` | §4.7 checks, recomputed from authoritative state |
| `exportSnapshot.ts` | Canonical projections, formula protection, the three artifacts (§10) |
| `auditReplay.ts` | Zod audit schema and `replayAudit` |

Every transition is pure: it returns a new state and never mutates the old one. A failed
decision returns the *same* state object plus a typed `{code, message}` that the UI can display.
The workflow reducer built on this is described in `workflow-state.md`.

## Ingestion

`parseDataset(side, fileName, bytes)` works through these steps in order:

1. Checks the size: empty, or larger than 262,144 bytes.
2. Hashes the original bytes, including any BOM.
3. Decodes with `TextDecoder("utf-8", {fatal: true})`. The decoder strips a leading BOM from the text, never from the hash.
4. Rejects NUL characters.
5. Parses with Papa Parse (`header:false`, `dynamicTyping:false`, `delimiter:","`).

It then validates the header as an array before anything is keyed by it, so duplicate headers can't be renamed:

- 2–12 columns.
- Headers must be nonempty and unique after trim and case fold.
- Every record must have the same width as the header.
- Cells are at most 2,048 code points (counted with `[...s].length`).
- There must be 1–200 nonblank records.

Columns are positional (`c0`, `c1`, …). Rows are arrays of raw strings, so a header named `__proto__` is just data.

Identities:

- `datasetId = sha256(originalBytes)`
- `rowId = side + ":" + datasetId + ":" + dataRecordIndex`

`dataRecordIndex` is 0-based over nonblank data records in original order. Because the side is part of the row ID, an identical file can be loaded as both A and B without collisions. No physical line numbers are recorded, because quoted cells can contain newlines.

Blank records:

- A zero-length line is counted in `parse.ignoredBlankRecords`.
- The file's final line terminator is not counted as a blank record.
- `,,` is an empty-valued data record and is kept.
- A whitespace-only line is a width error.

Every parse error carries a code and an index, never a cell value.

## Configuration and hash

`validateConfiguration` accepts drafts in which every field may be null (§7.2). These rules apply:

- `name` and `quantity` are required and must be distinct columns.
- No column can be reused across fields.
- Every referenced column must exist.
- A null `productId` is valid. It only disables exact-ID matching for that source.

`configurationHash` is SHA-256 (lowercase hex) of `JSON.stringify` applied to this fixed array:

```text
["accord.configuration", 1,
 A.datasetId, B.datasetId,
 [A.productId, A.name, A.quantity, A.unit],
 [B.productId, B.name, B.quantity, B.unit],
 idCaseSensitive, sharedQuantityUnitConfirmed,
 parserPolicyVersion, matchingPolicyVersion]
```

The hash is computed from an array, never an object, so key order cannot change it. Tests confirm that the hash is the same whatever order the configuration's keys were written in, and that changing any element changes it. The hash marks results computed under a different configuration as stale. It does not prove authenticity.

## Identity and eligibility

ID normalization:

- Trim surrounding whitespace.
- Case-sensitive by default.
- Optional case-insensitive mode uses `toUpperCase().toLowerCase()`, an approximation of Unicode full case folding (`ß` and `SS` both become `ss`).
- IDs are never parsed as numbers, leading zeros are never stripped (`0012` ≠ `12`), and punctuation is kept.

**Duplicate-ID quarantine.** If a normalized ID occurs more than once in *either* source, every row carrying it is quarantined on both sides. That includes an otherwise unique occurrence on the opposite side. Quarantined rows can't be paired, automatically or by hand.

`checkPair(ctx, ledger, leftId, rightId, method)` is the single policy. Exact matching, candidate retrieval, proposal intake (identity part), every decision, the invariant checker and audit replay all call it. It checks these in order:

| Check | Failure code |
| --- | --- |
| Both rows exist; left is A, right is B | `unknown_row`, `wrong_side` |
| Neither row quarantined | `duplicate_id` |
| Not two different nonempty IDs | `conflicting_id` |
| `exact_id` only: both IDs present (and therefore equal) | `not_exact_id` |
| `semantic` only: both names nonempty | `missing_name` |
| Not an excluded exact pair | `excluded_exact_pair` |
| Not a rejected pair | `rejected_pair` |
| Neither row in an accepted pair | `unavailable` |

Unique identical IDs pair automatically even when names or quantities differ, or when one name is empty. The differences stay visible in the export. If at least one side has no ID, semantic or manual pairing is allowed.

## Candidate retrieval

Names go through these steps:

1. NFKC normalization.
2. Case fold.
3. Every run of non-letter/mark/number characters becomes a space.
4. Trim.
5. Split into a token set.

Candidates are scored by token-set Jaccard similarity. `candidatesFor(state, leftId)` returns at most five Source B rows. A row is returned only if it has a positive score and passes `checkPair(..., "semantic")`. Results are sorted by score descending, then by Source B record index.

Quantities never influence the score. There is no synonym dictionary and no fuzzy acceptance. Zero overlap means *retrieval* found nothing, which gives the reason `no_candidates`. It does not mean there is no counterpart. `eligibleRightRows` gives the manual picker every eligible row, including zero-overlap ones.

Candidates reserve nothing: two proposals may name the same B row. Only acceptance enforces availability.

## Decisions

`applyDecision(state, decision)` handles all human actions. Every decision is checked like this:

- A decision whose `configurationHash` isn't current fails with `stale_configuration`.
- A repeated decision ID with the same payload (ignoring `at`) is a no-op. That makes double-clicks idempotent.
- The same ID with a different payload fails with `decision_id_conflict`.
- Each effective decision is appended to `decisions` and increments `revision`.

| Action | Effect |
| --- | --- |
| `accept` | Re-checks the policy atomically. With `proposalId`, the proposal must exist, be current, be a `suggest` and name the same rows; the method is then `ai_reviewed`. Without it the method is `manual`. The pair ID is `decision:<id>`. |
| `reject` | Records the `(A, B)` exclusion for this configuration. Neither row moves. |
| `defer` | Recorded only. The row's latest decision gives the reason `deferred`. |
| `exclude_exact` | Removes a current exact pair and records the exclusion, so later proposals or re-renders can't reinstate it. |
| `undo` | Removes the accepted non-exact pair, *or* restores an excluded exact pair if both rows are still free, *or* lifts a rejection. Never calls the model. |

Proposal status is derived, not stored (`pending | accepted | rejected | unavailable | abstained | stale`). Accepting one pair therefore turns competing proposals `unavailable` with no extra bookkeeping.

`addProposals` is the client-side re-validation of `/api/suggest` output:

- It drops the whole batch when the generation or configuration hash is stale.
- It drops individual proposals that name an unknown row, duplicate a row, have an invalid target, or cite evidence that doesn't exactly equal a real cell (or covers only one side).
- It assigns app IDs `<requestId>:<leftId>`.
- It replaces older proposals for the same rows unless a decision references them.
- It treats a proposal ID that is already present as a replay of the same request, so a replayed batch returns the same state.

`nextGeneration` advances the generation so late results are ignored.

## Quantities and units

Grammar: `^-?\d{1,12}(\.\d{1,3})?$` after trimming.

- Blank means *missing*, never zero.
- Rejected forms include `1,200`, `3kg`, `1e3`, `.5`, `5.` and `+5`.
- Valid values become BigInt thousandths.
- `delta = B − A`, computed exactly. For example, `0.1`/`0.3` gives `0.2`, and `6`/`5` gives `-1`.
- Output is canonical: no trailing zeros, no bare point, and `-0` becomes `0`.
- BigInt never reaches JSON.

Status is decided in this order:

1. `invalid`: either value is missing or unparseable.
2. Unit rules:
   - Neither side maps a unit: the explicit shared-unit assertion is required, otherwise `unit_unknown`.
   - Only one side maps a unit, or either unit cell is blank: `unit_unknown`.
   - Units differ after trim and case fold: `unit_mismatch`. There's no conversion, so `kg` vs `kilogram` is a mismatch.
3. `equal` / `different`.

## Unresolved reasons

Each unmatched row gets one primary reason. They're checked in the §6 priority order:

1. **Conflict:**
   - `duplicate_id`
   - `missing_name`
   - `conflicting_id`: no candidates, but a lexically overlapping B row was blocked only by an ID conflict.
2. **User decision:**
   - `deferred` (the row's latest decision).
   - `rejected` (an exact-pair exclusion or a rejected suggestion).
3. **Analysis:**
   - `ambiguous` (an ambiguous abstention)
   - `analysis_failed` (the row failed, or the run failed before reaching it)
   - `analysis_cancelled`
   - `no_candidates`
   - `analysis_limit` (eligible, but outside the pass's selected rows)
4. **Otherwise:** `unpaired`, with a detail such as "Suggested pair awaiting review".

## Invariants

`checkInvariants(state)` recomputes everything from authoritative state. It checks that:

- every pair's rows exist and its hash is current;
- pair IDs are unique and no A or B row is reused;
- each pair passes `checkPair` against the *other* pairs (`exact_id` for automatic pairs, semantic otherwise);
- automatic pairs carry no decision data and use the canonical ID;
- every semantic/manual pair has a matching, not-undone `accept` decision, and, for `ai_reviewed`, a real `suggest` proposal for the same rows;
- rejection and exclusion ledgers reference real rows;
- `|A| = |P| + |UA|` and `|B| = |P| + |UB|`, with every row appearing exactly once.

A seeded property test runs 200 random datasets through 25 random decisions each, including AI-proposal acceptances. It asserts that these properties hold after every step, that failed decisions return the identical state, and that every decision kind actually occurred.

## Export snapshot

`prepareExport(state, {appVersion, generatedAt, runId, modelRuns})`:

1. Runs the invariants. On failure it returns `{ok:false, violations}` and **no** artifacts.
2. Builds `matches.csv`, `unresolved.csv` and `audit.json` from that one state and revision.
3. Recomputes quantities, statuses and reasons from source cells.
4. Writes CSVs with explicit `fields` in the §10 order and CRLF line endings.
5. Formula-protects source text:
   - A cell gets an apostrophe prefix when its first non-whitespace character is `= + - @`, or when it starts with a tab or CR.
   - Plain decimal numbers (`-3`) are left alone because they can't carry a formula.
   - Computed deltas are written raw.
   - The audit keeps the unescaped strings.
   - Leading zeros are never wrapped in `="…"`.

`isSnapshotCurrent(state, snapshot)` goes false after any edit (revision) or reconfiguration (hash). That is the cue to revoke download URLs.

## Audit replay

`replayAudit(json)` is pure and never calls the model. It runs these steps:

1. Validates the JSON with a strict Zod schema (unknown fields are rejected).
2. Checks that row IDs, indices, widths and positional column IDs are consistent.
3. Re-validates the mappings and recomputes the configuration hash.
4. Rebuilds the context and exact pairs, validates every proposal, and replays **every decision in order** through `applyDecision`. Any decision that fails or repeats is rejected.
5. Requires accepted pairs, exclusions, unmatched rows and their reasons, analysis counts and invariant counts to equal the audit's.
6. Returns the canonical match and unresolved rows and CSV strings.

The integration test checks that these strings are byte-identical to the exported ones. Tamper tests cover each failure listed above.

Replay verifies semantics, not the original file bytes. Dataset IDs are checked for shape and consistency with row IDs, but they can't be recomputed without the original files. The audit is an inspectable local record, not tamper-proof evidence.

## Integration boundary with the FastAPI service

The API never sees engine state. When the browser calls `/api/suggest` it will:

1. Pick up to 20 rows from `analysisEligibleRows(state)`.
2. Send batches of five, each row with its `candidatesFor` set. Fields are the mapped name and product ID as `EvidenceRef`s. Quantities are never sent.
3. Pass the response's `proposals` to `addProposals` with the echoed `requestId`, `generation` and `configurationHash`.

The API's verification and the engine's `proposalDefect` check overlap on purpose (§5.2). The API's `Proposal` has no `id`; the engine assigns it. `meta.promptVersion` is an integer in the API and is stored as a string in `modelRuns`.

## Deliberate limitations

- Bare `"` inside an *unquoted* field is kept as a literal (Papa Parse behavior). Unterminated or trailing-garbage quotes are rejected. Files that mix CRLF and LF outside quotes are rejected.
- Case folding is an approximation; locale-specific rules (Turkish dotless i) are not applied.
- Full-width formula characters (`＝`) are not treated as triggers.
- Retrieval misses true synonyms with zero token overlap. The manual picker covers them.
- Rows with empty names can't be paired semantically or manually; only exact ID can pair them.
- A rejected pair can't be accepted until the rejection is undone. An excluded exact pair can be restored only by undo.
- Evidence must equal the full source cell. The 160-character AI-context clipping in §7.4 isn't built yet, and clipped evidence will need the matching rule once it is.
- `audit.analysis` adds `selectedRowIds`, `analyzedRowIds` and `failedRowIds` to the spec's counts so replay can rebuild analysis-dependent reasons. This is the only schema addition.

## Running the tests

```sh
cd web
pnpm test           # vitest run: parser, mapping, quantity, candidates, reconcile, invariants (+property), export/replay, integration
npx tsc --noEmit
pnpm lint
```
