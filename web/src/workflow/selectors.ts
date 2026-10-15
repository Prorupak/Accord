// Derived workflow views. Everything here is recomputed from WorkflowState through domain
// functions; none of it is stored.
import { analysisEligibleRows } from "../domain/exportSnapshot";
import { validateConfiguration, type MappingError } from "../domain/mapping";
import { compareQuantities } from "../domain/quantity";
import { partition, pendingProposals } from "../domain/reconcile";
import type { Dataset, RowId, TaskStatus } from "../domain/types";
import type { RunRef, Stage, WorkflowState } from "./types";

export function loadedDatasets(state: WorkflowState): { A: Dataset; B: Dataset } | null {
  const { A, B } = state.sources;
  return A.dataset && B.dataset ? { A: A.dataset, B: B.dataset } : null;
}

// Empty when the draft is valid; null when there is nothing to validate yet.
export function mappingErrors(state: WorkflowState): MappingError[] | null {
  const datasets = loadedDatasets(state);
  if (!datasets) return null;
  const r = validateConfiguration(datasets, state.draft);
  return r.ok ? [] : r.error;
}

export const canConfirmMappings = (state: WorkflowState) => mappingErrors(state)?.length === 0;

export const analysisStatus = (state: WorkflowState): TaskStatus => state.reconciliation?.analysis.status ?? "idle";

const isRunning = (state: WorkflowState) => analysisStatus(state) === "running";

export const canStartAnalysis = (state: WorkflowState) =>
  state.reconciliation !== null && !isRunning(state) && analysisEligibleRows(state.reconciliation).length > 0;

// §3.4: confirmation runs the exact-match pass, so export only waits for a live run to end.
export const canExport = (state: WorkflowState) => state.reconciliation !== null && !isRunning(state);

export function canEnterStage(state: WorkflowState, stage: Stage): boolean {
  switch (stage) {
    case "import":
      return true;
    case "mapping":
      return loadedDatasets(state) !== null;
    case "review":
      return state.reconciliation !== null;
    case "export":
      return canExport(state);
  }
}

// Matched pairs may also count as quantity differences; the totals overlap by design (§3.3).
export function counts(state: WorkflowState) {
  const rec = state.reconciliation;
  if (!rec) return null;
  const { pairs, unmatchedA, unmatchedB } = partition(rec);
  return {
    matched: pairs.length,
    needsReview: pendingProposals(rec).length,
    unresolvedA: unmatchedA.length,
    unresolvedB: unmatchedB.length,
    quantityDifferences: pairs.filter((p) => compareQuantities(rec.context, p.leftId, p.rightId).status === "different").length,
  };
}

export function analysisProgress(state: WorkflowState) {
  const a = state.reconciliation?.analysis;
  return { selected: a?.selectedRowIds.length ?? 0, analyzed: a?.analyzedRowIds.length ?? 0, failed: a?.failedRowIds.length ?? 0 };
}

// The run 03-II should be working on, or null when none is active.
export function activeRun(state: WorkflowState): (RunRef & { selectedRowIds: readonly RowId[] }) | null {
  const rec = state.reconciliation;
  if (!rec || rec.analysis.status !== "running") return null;
  return { generation: rec.generation, configurationHash: rec.context.configurationHash, selectedRowIds: rec.analysis.selectedRowIds };
}

export function isStaleResult(state: WorkflowState, ref: RunRef): boolean {
  const run = activeRun(state);
  return run === null || run.generation !== ref.generation || run.configurationHash !== ref.configurationHash;
}

export const hasRecoverableError = (state: WorkflowState) => state.error !== null && state.error.kind !== "invalid_transition";
