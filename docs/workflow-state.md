# Accord workflow state

The workflow layer in `web/src/workflow/` wraps the domain engine (`docs/domain-engine.md`) in one
application lifecycle (spec §9). It decides whether an event is current. The domain engine decides
what that event does to reconciliation.

| File | Role |
| --- | --- |
| `types.ts` | `WorkflowState`, `WorkflowAction`, `WorkflowError`, `RunRef` |
| `workflowReducer.ts` | `initialWorkflowState` and the pure `workflowReducer` |
| `selectors.ts` | Stage gates, counts, analysis views and staleness checks, all derived |
| `boundary.ts` | Async work done before dispatch: `parseSource` and `prepareConfirmation` (hashing) |
| `useAccordWorkflow.ts` | One `useReducer`. Creates import tokens, decision IDs and timestamps |
| `testkit.ts` | Test-only helpers that run the real parser and hashing |

## 1. State ownership

```ts
type WorkflowState = {
  stage: "import" | "mapping" | "review" | "export";
  sources: { A: ImportSlot; B: ImportSlot };      // ImportSlot = { dataset, pendingToken }
  draft: DraftConfiguration;
  reconciliation: ReconciliationState | null;     // non-null exactly when mappings are confirmed
  error: WorkflowError | null;
};
```

| Field | Owns | Notes |
| --- | --- | --- |
| `stage` | Navigation only | Separate from task status (§9) |
| `sources.*.dataset` | Parsed, frozen datasets | |
| `sources.*.pendingToken` | Which in-flight import may commit | Created outside the reducer |
| `draft` | The editable mapping form | Validity is derived through `validateConfiguration` |
| `reconciliation` | Confirmed configuration, hash, generation, revision, pairs, decisions, proposals, analysis record and status | Domain-owned. The workflow never copies these fields |
| `error` | The last error to display | Display only. Never touches revision |

Counts, proposal status, eligibility, comparisons and progress are never stored. There is no
workflow-level run ID or task status. A run is identified by `(reconciliation.generation,
context.configurationHash)` while `analysis.status === "running"`.

## 2. Actions

| Action | Kind | Effect |
| --- | --- | --- |
| `import/started {side, token}` | Intent | Records the token as the side's only valid import |
| `import/succeeded {side, token, dataset}` | External result | Ignored unless `token` is current. Otherwise commits the dataset and invalidates downstream state (§4) |
| `import/failed {side, token, error}` | External result | Ignored unless `token` is current. Keeps the previous dataset and sets `import_failed` |
| `source/cleared {side}` | Intent | Same invalidation as a replacement. Drops any pending token |
| `workflow/reset` | Intent | Returns `initialWorkflowState` |
| `draft/fieldMapped`, `draft/optionSet` | Intent | Edits the draft only. A redundant edit returns the same state |
| `mapping/confirmed {datasetIds, configuration, configurationHash}` | Validated result | See §4 |
| `decision/requested {decision}` | Intent | Delegates to `applyDecision` (§7) |
| `analysis/started` | Lifecycle | See §5 |
| `analysis/batchReceived {batch, rowIds}` | External result | See §5 |
| `analysis/batchFailed`, `completed`, `cancelled`, `failed` | Lifecycle | See §5. Each carries a `RunRef` |
| `stage/navigated {stage}` | Intent | Allowed only when `canEnterStage` passes |
| `error/dismissed` | Intent | Clears `error` |

There is no generic setter. The `default` branch is an exhaustive `never` check.

## 3. Transition matrix

| Event | Requires | Result |
| --- | --- | --- |
| Import commits | Current token | Dataset set, stage `import`, reconciliation cleared |
| Confirm mappings | Both datasets loaded, a valid draft, and inputs unchanged since hashing | `initializeState(buildContext(…))`, stage `review` |
| Decision | Reconciliation exists | `applyDecision` result |
| Start analysis | Reconciliation exists, not running, ≥1 eligible row | `nextGeneration`, then `recordAnalysis(running, selected ≤ 20)` |
| Batch, batch failure, completion, cancellation or failure | Running, and the event's generation and hash are current | Applied; the terminal events then call `nextGeneration` |
| Navigate | `import` always; `mapping` needs both datasets; `review` needs reconciliation; `export` needs reconciliation and no active run | Stage set |

## 4. Dataset and configuration invalidation

- **Replacing or clearing a source** commits only that side. It resets that side's draft mapping,
  sets `reconciliation` to `null` (which drops pairs, decisions, proposals and the active run) and
  returns to `import`. The other source and its draft are kept. Asking the user to confirm before
  decisions are discarded is the UI's job. The reducer always applies the reset.
- **Import races.** Each file choice gets a fresh token. Only the latest token can commit, so if
  A1 finishes after A2, A1 is dropped.
- **Confirmation** is prepared asynchronously by `prepareConfirmation`, which validates and hashes.
  The reducer re-validates the *current* draft against the *current* datasets and compares
  `configurationTuple`s:
  - The current draft is invalid: `invalid_configuration`.
  - The tuple differs, because a source was replaced or the draft was edited during hashing:
    `stale_configuration`.
  - The hash equals the live reconciliation's: no rebuild, so decisions are kept.
  - Otherwise a fresh `initializeState` replaces reconciliation, and every earlier decision and
    proposal is dropped.
- **Draft edits after confirmation** do not touch reconciliation until the user confirms again.
- **Confirming over existing work.** `confirmMappings(approve?)` passes the prepared
  `mapping/confirmed` action to `approve` before dispatching it. The mapping screen uses this to
  ask the user only when the new hash differs and the current reconciliation has decisions or
  proposals. Declining dispatches nothing. Without `approve` the hook behaves as before.

## 5. Runs, generations and staleness

| Identity | Bound to | Guarded by |
| --- | --- | --- |
| `configurationHash` | Datasets, mappings and policies | Every run event and every decision (`applyDecision`) |
| `generation` | One analysis run | Every run event, plus `addProposals` and `recordAnalysis` |
| `revision` | Authoritative reconciliation changes | Moved only by domain functions |

- **Start** calls `nextGeneration` and records `running` with `selectedRowIds =
  analysisEligibleRows(rec).slice(0, 20)`. Proposals, pairs and decisions are preserved. Only an
  `analysis_failed` error is cleared.
- **Batch received.** `rowIds` (the rows that were requested) must be a subset of the selection,
  otherwise the result is `invalid_transition`. Proposals go through `addProposals`. A requested
  row counts as **analyzed** only when a proposal with ID `proposalIdOf(requestId, row)` is
  retained. Rows whose proposals were dropped or missing go to `failedRowIds`. `recordAnalysis`
  runs only if the record changed, so a duplicate batch returns the identical state.
- **Batch failed.** The rows go to `failedRowIds`. They are never counted as analyzed.
- **Completed.** The status becomes `complete`, or `partial` when any selected row failed or was
  never processed while it still had candidates. A row that a human paired, or whose candidates were
  all paired or rejected during the run, no longer needs inference. The orchestrator does not send
  it, it is not counted as analyzed or failed, and it keeps its own reason (usually
  `no_candidates`).
- **Cancelled.** The status becomes `cancelled`. Accounting and proposals are kept. Unprocessed
  rows get the reason `analysis_cancelled`.
- **Failed.** The status becomes `failed`, and `error` is set to `analysis_failed`. Pairs,
  decisions, proposals and accounting are kept. Selected rows the run never reached stay
  unprocessed rather than going to `failedRowIds`, so the audit counts only rows that were actually
  attempted. They are still explained as `analysis_failed` ("Analysis stopped before this record
  was reviewed").
- **Every terminal transition then calls `nextGeneration`.** A late event for that run fails both
  the workflow guard and the domain's own generation checks. A new run after a reconfiguration
  can reuse a generation number, because `initializeState` restarts it at 0. The hash still
  rejects the old run's events.
- **Stale events are silent no-ops.** They return the same object, so they cannot replace a
  useful current error.

## 6. Revision semantics

The workflow never writes `revision`. It changes only through `applyDecision` (effective
decisions), `addProposals` (new proposals) and `recordAnalysis` (a changed analysis record).
Navigation, error display or dismissal, draft edits, stale events, duplicate decisions and
duplicate batches leave it unchanged.

Fixed in this phase: `addProposals` used to drop and re-add an unreferenced proposal when the same
batch was replayed, which bumped revision without any change. A proposal ID that is already
present is now treated as a replay.

## 7. Decision delegation

`decision/requested` carries a complete `UserDecision`. The hook creates `id` and `at`, so a retry
of the same intent reuses the ID. The reducer calls `applyDecision(reconciliation, decision)` and
nothing else:

| Domain result | Workflow result |
| --- | --- |
| `ok` and `changed` | New reconciliation, error cleared |
| `ok` and not `changed` (a duplicate ID with the same payload) | The same state object |
| Not `ok` | Reconciliation unchanged; `error = {kind: "decision_rejected", error}` |

Eligibility, one-to-one pairing, exclusions, undo and ID conflicts are entirely the domain's.

## 8. Errors

| Kind | Cause | Type |
| --- | --- | --- |
| `import_failed` | Parser error for the current token (code and index only) | User-correctable |
| `invalid_configuration` | The draft fails validation at confirmation | User-correctable |
| `stale_configuration` | Inputs changed while the confirmation was being prepared | User-correctable (confirm again) |
| `missing_prerequisite` | An action before its stage (no sources, no confirmation, nothing to analyze) | User-correctable |
| `decision_rejected` | `applyDecision`'s typed `{code, message}` | User-correctable |
| `analysis_failed` | The current run failed | Task-level |
| `invalid_transition` | An action the UI should not have been able to send | Programming error |

None of these carry source cell values.

## 9. Selectors

`loadedDatasets`, `mappingErrors`, `canConfirmMappings`, `canStartAnalysis`, `canExport`,
`canEnterStage`, `counts` (matched, needsReview, unresolvedA/B, quantityDifferences),
`analysisStatus`, `analysisProgress`, `activeRun`, `isStaleResult` and `hasRecoverableError`.

They delegate to `validateConfiguration`, `partition`, `pendingProposals`, `compareQuantities`
and `analysisEligibleRows`. Counts overlap by design (§3.3). The hook memoizes one view object
per state.

## 10. Phase 03-II contract

The orchestrator:

1. Dispatches `analysis/started`, then reads `activeRun(state)` →
   `{generation, configurationHash, selectedRowIds}`.
2. Builds requests from `selectedRowIds` and `candidatesFor`. Dispatches
   `analysis/batchReceived {batch: {requestId, generation, configurationHash, proposals}, rowIds}`
   with the echoed values, or `analysis/batchFailed {generation, configurationHash, rowIds}`.
3. Finishes with `analysis/completed`, `analysis/cancelled` or `analysis/failed {message}`, each
   carrying the same `RunRef`.

Implemented in Phase 03-II; see `docs/ai-orchestration.md`. It never compares generations itself: outdated events are dropped by the reducer. The reducer
knows nothing about HTTP, OpenRouter, retries, scheduling, Zod or `AbortController`.
`isStaleResult` lets the orchestrator skip work early, for example to stop scheduling batches.
