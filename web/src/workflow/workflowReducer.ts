// The single authoritative workflow transition function (spec §9). Pure: no I/O, clocks, IDs or
// hashing. Reconciliation changes are delegated to the domain engine, which owns revision and
// generation; this reducer only decides whether an event is current enough to reach it.
import { buildContext } from "../domain/eligibility";
import { analysisEligibleRows } from "../domain/exportSnapshot";
import { configurationTuple, validateConfiguration, type DraftMapping } from "../domain/mapping";
import {
  addProposals,
  applyDecision,
  initializeState,
  nextGeneration,
  proposalIdOf,
  recordAnalysis,
  type AnalysisRecord,
  type ReconciliationState,
} from "../domain/reconcile";
import { LIMITS, type Dataset, type RowId, type Side } from "../domain/types";
import { canEnterStage, loadedDatasets } from "./selectors";
import type { RunRef, WorkflowAction, WorkflowError, WorkflowState } from "./types";

const EMPTY_MAPPING: DraftMapping = Object.freeze({ productId: null, name: null, quantity: null, unit: null });

export const initialWorkflowState: WorkflowState = Object.freeze({
  stage: "import",
  sources: Object.freeze({ A: Object.freeze({ dataset: null, pendingToken: null }), B: Object.freeze({ dataset: null, pendingToken: null }) }),
  draft: Object.freeze({ A: EMPTY_MAPPING, B: EMPTY_MAPPING, idCaseSensitive: true, sharedQuantityUnitConfirmed: false }),
  reconciliation: null,
  error: null,
});

const sameList = (x: readonly RowId[], y: readonly RowId[]) => x.length === y.length && x.every((v, i) => v === y[i]);
const union = (x: readonly RowId[], y: readonly RowId[]) => [...x, ...y.filter((id) => !x.includes(id))];

// Committing or clearing one source discards everything confirmed against the old pair of
// files (§3.1). The other source and its draft mapping are kept.
function replaceSource(state: WorkflowState, side: Side, dataset: Dataset | null): WorkflowState {
  return {
    stage: "import",
    sources: { ...state.sources, [side]: { dataset, pendingToken: null } },
    draft: { ...state.draft, [side]: EMPTY_MAPPING },
    reconciliation: null,
    error: null,
  };
}

// The reconciliation state a run event may touch, or null when the event is stale: no run is
// active, or it was started under another generation or configuration.
function currentRun(state: WorkflowState, ref: RunRef): ReconciliationState | null {
  const rec = state.reconciliation;
  if (!rec || rec.analysis.status !== "running") return null;
  return rec.generation === ref.generation && rec.context.configurationHash === ref.configurationHash ? rec : null;
}

// Merges real outcomes into the analysis record. recordAnalysis bumps revision unconditionally,
// so it is skipped when nothing changed (duplicate batches must be no-ops).
function updateAnalysis(
  rec: ReconciliationState,
  change: { analyzed?: readonly RowId[]; failed?: readonly RowId[]; status?: AnalysisRecord["status"] },
): ReconciliationState {
  const a = rec.analysis;
  const analyzedRowIds = union(a.analyzedRowIds, change.analyzed ?? []);
  const failedRowIds = union(a.failedRowIds, change.failed ?? []).filter((id) => !analyzedRowIds.includes(id));
  const status = change.status ?? a.status;
  if (status === a.status && sameList(analyzedRowIds, a.analyzedRowIds) && sameList(failedRowIds, a.failedRowIds)) return rec;
  return recordAnalysis(rec, rec.generation, rec.context.configurationHash, { ...a, status, analyzedRowIds, failedRowIds });
}

const unprocessed = (a: AnalysisRecord) => a.selectedRowIds.filter((id) => !a.analyzedRowIds.includes(id) && !a.failedRowIds.includes(id));

// Every terminal transition advances the generation, so late events for the finished run fail
// both this reducer's guard and the domain's own generation checks.
const finish = (rec: ReconciliationState, change: Parameters<typeof updateAnalysis>[1]) => nextGeneration(updateAnalysis(rec, change));

export function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  const reject = (error: WorkflowError): WorkflowState => ({ ...state, error });
  const missing = (message: string) => reject({ kind: "missing_prerequisite", message });
  const invalid = (message: string) => reject({ kind: "invalid_transition", action: action.type, message });
  const withReconciliation = (reconciliation: ReconciliationState): WorkflowState =>
    reconciliation === state.reconciliation ? state : { ...state, reconciliation };

  switch (action.type) {
    case "import/started":
      return { ...state, sources: { ...state.sources, [action.side]: { ...state.sources[action.side], pendingToken: action.token } } };

    case "import/succeeded":
      if (state.sources[action.side].pendingToken !== action.token) return state;
      if (action.dataset.side !== action.side) return invalid("The dataset was parsed for the other source.");
      return replaceSource(state, action.side, action.dataset);

    case "import/failed": {
      const slot = state.sources[action.side];
      if (slot.pendingToken !== action.token) return state;
      return {
        ...state,
        sources: { ...state.sources, [action.side]: { ...slot, pendingToken: null } },
        error: { kind: "import_failed", side: action.side, error: action.error },
      };
    }

    case "source/cleared":
      return replaceSource(state, action.side, null);

    case "workflow/reset":
      return initialWorkflowState;

    case "draft/fieldMapped": {
      const mapping = state.draft[action.side];
      if (mapping[action.field] === action.columnId) return state;
      return { ...state, draft: { ...state.draft, [action.side]: { ...mapping, [action.field]: action.columnId } } };
    }

    case "draft/optionSet":
      if (state.draft[action.option] === action.value) return state;
      return { ...state, draft: { ...state.draft, [action.option]: action.value } };

    case "mapping/confirmed": {
      const datasets = loadedDatasets(state);
      if (!datasets) return missing("Load both sources before confirming mappings.");
      const current = validateConfiguration(datasets, state.draft);
      if (!current.ok) return reject({ kind: "invalid_configuration", errors: current.error });
      // The hash was computed asynchronously; it is only trusted if the inputs it was computed
      // from are still the current datasets and draft.
      const ids = { A: datasets.A.id, B: datasets.B.id };
      const tuple = (x: typeof ids, c: typeof current.value) => JSON.stringify(configurationTuple(x, c));
      if (tuple(ids, current.value) !== tuple(action.datasetIds, action.configuration))
        return reject({ kind: "stale_configuration", message: "The sources or mappings changed while confirming. Confirm again." });
      if (state.reconciliation?.context.configurationHash === action.configurationHash)
        return { ...state, stage: "review", error: null };
      const reconciliation = initializeState(buildContext(datasets, current.value, action.configurationHash));
      return { ...state, stage: "review", reconciliation, error: null };
    }

    case "decision/requested": {
      if (!state.reconciliation) return missing("Confirm mappings before reviewing records.");
      const r = applyDecision(state.reconciliation, action.decision);
      if (!r.ok) return reject({ kind: "decision_rejected", error: r.error });
      return r.changed ? { ...state, reconciliation: r.state, error: null } : state;
    }

    case "analysis/started": {
      const rec = state.reconciliation;
      if (!rec) return missing("Confirm mappings before starting analysis.");
      if (rec.analysis.status === "running") return invalid("An analysis run is already active.");
      const selectedRowIds = analysisEligibleRows(rec).slice(0, LIMITS.maxAnalysisRows);
      if (selectedRowIds.length === 0) return missing("No unmatched Source A record has candidates to analyze.");
      const next = nextGeneration(rec);
      const reconciliation = recordAnalysis(next, next.generation, next.context.configurationHash, {
        status: "running",
        selectedRowIds,
        analyzedRowIds: [],
        failedRowIds: [],
      });
      return { ...state, reconciliation, error: state.error?.kind === "analysis_failed" ? null : state.error };
    }

    case "analysis/batchReceived": {
      const rec = currentRun(state, action.batch);
      if (!rec) return state;
      if (!action.rowIds.every((id) => rec.analysis.selectedRowIds.includes(id)))
        return invalid("The batch covers records outside the current analysis run.");
      const intake = addProposals(rec, action.batch);
      // A requested row counts as analyzed only if a validated proposal for it is retained.
      const retained = new Set(intake.state.proposals.map((p) => p.id));
      const kept = (id: RowId) => retained.has(proposalIdOf(action.batch.requestId, id));
      return withReconciliation(
        updateAnalysis(intake.state, { analyzed: action.rowIds.filter(kept), failed: action.rowIds.filter((id) => !kept(id)) }),
      );
    }

    case "analysis/batchFailed": {
      const rec = currentRun(state, action);
      if (!rec) return state;
      if (!action.rowIds.every((id) => rec.analysis.selectedRowIds.includes(id)))
        return invalid("The failed batch covers records outside the current analysis run.");
      return withReconciliation(updateAnalysis(rec, { failed: action.rowIds }));
    }

    case "analysis/completed": {
      const rec = currentRun(state, action);
      if (!rec) return state;
      const incomplete = rec.analysis.failedRowIds.length > 0 || unprocessed(rec.analysis).length > 0;
      return withReconciliation(finish(rec, { status: incomplete ? "partial" : "complete" }));
    }

    case "analysis/cancelled": {
      const rec = currentRun(state, action);
      if (!rec) return state;
      return withReconciliation(finish(rec, { status: "cancelled" }));
    }

    case "analysis/failed": {
      const rec = currentRun(state, action);
      if (!rec) return state;
      return {
        ...state,
        reconciliation: finish(rec, { status: "failed", failed: unprocessed(rec.analysis) }),
        error: { kind: "analysis_failed", message: action.message },
      };
    }

    case "stage/navigated":
      if (state.stage === action.stage) return state;
      if (!canEnterStage(state, action.stage)) return invalid(`The ${action.stage} stage is not available yet.`);
      return { ...state, stage: action.stage };

    case "error/dismissed":
      return state.error === null ? state : { ...state, error: null };

    default:
      return assertNever(action);
  }
}

function assertNever(action: never): never {
  throw new Error(`Unhandled workflow action: ${(action as { type?: string }).type}`);
}
