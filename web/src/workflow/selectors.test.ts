import { describe, expect, it } from "vitest";
import {
  activeRun,
  analysisProgress,
  analysisStatus,
  canConfirmMappings,
  canEnterStage,
  canExport,
  canStartAnalysis,
  counts,
  hasRecoverableError,
  isStaleResult,
  mappingErrors,
} from "./selectors";
import { SOURCE_A, batch, confirmed, decide, load, loaded, mapBoth, rec, reduce, rowA, rowB, runRef, suggestion } from "./testkit";
import { initialWorkflowState, workflowReducer } from "./workflowReducer";

describe("stage gates", () => {
  it("unlock in order: import → mapping → review → export", async () => {
    const one = await load(initialWorkflowState, "A", SOURCE_A);
    const both = await loaded();
    const done = await confirmed();
    const running = workflowReducer(done, { type: "analysis/started" });
    const gates = (s: typeof done) => (["import", "mapping", "review", "export"] as const).map((st) => canEnterStage(s, st));
    expect(gates(initialWorkflowState)).toEqual([true, false, false, false]);
    expect(gates(one)).toEqual([true, false, false, false]);
    expect(gates(both)).toEqual([true, true, false, false]);
    expect(gates(done)).toEqual([true, true, true, true]);
    expect(gates(running)).toEqual([true, true, true, false]);
    expect(canExport(workflowReducer(running, { type: "analysis/cancelled", ...runRef(running) }))).toBe(true);
  });

  it("derive mapping validity from the draft", async () => {
    expect(mappingErrors(initialWorkflowState)).toBeNull();
    const both = await loaded();
    expect(mappingErrors(both)).toEqual([]);
    expect(canConfirmMappings(both)).toBe(true);
    const bad = mapBoth(both, { productId: null, name: "c1", quantity: "c1", unit: null });
    expect(canConfirmMappings(bad)).toBe(false);
    expect(mappingErrors(bad)).toEqual(expect.arrayContaining([{ side: "A", field: "quantity", code: "column_reused" }]));
  });

  it("allow analysis only with candidates and no active run", async () => {
    const done = await confirmed();
    expect(canStartAnalysis(await loaded())).toBe(false);
    expect(canStartAnalysis(done)).toBe(true);
    expect(canStartAnalysis(workflowReducer(done, { type: "analysis/started" }))).toBe(false);
  });
});

describe("counts", () => {
  it("are derived from domain selectors and update after decisions and batches", async () => {
    const s = await confirmed();
    // P03 is 6 vs 5, so one matched pair also counts as a quantity difference.
    expect(counts(s)).toEqual({ matched: 2, needsReview: 0, unresolvedA: 2, unresolvedB: 2, quantityDifferences: 1 });
    const running = workflowReducer(s, { type: "analysis/started" });
    const reviewed = workflowReducer(running, batch(running, "r1", [suggestion(running, rowA(s, 1), rowB(s, 1))], [rowA(s, 1)]));
    expect(counts(reviewed)?.needsReview).toBe(1);
    const accepted = workflowReducer(reviewed, decide(s, "accept", rowA(s, 1), rowB(s, 1), { proposalId: rec(reviewed).proposals[0].id }));
    expect(counts(accepted)).toEqual({ matched: 3, needsReview: 0, unresolvedA: 1, unresolvedB: 1, quantityDifferences: 1 });
  });
});

describe("analysis views", () => {
  it("report status, progress, the active run and staleness", async () => {
    const s = await confirmed();
    expect(analysisStatus(s)).toBe("idle");
    expect(activeRun(s)).toBeNull();
    const running = workflowReducer(s, { type: "analysis/started" });
    const ref = runRef(running);
    expect(analysisStatus(running)).toBe("running");
    expect(isStaleResult(running, ref)).toBe(false);
    expect(isStaleResult(running, { ...ref, generation: ref.generation - 1 })).toBe(true);
    const after = reduce(running, { type: "analysis/batchFailed", ...ref, rowIds: [rowA(s, 3)] }, { type: "analysis/completed", ...ref });
    expect(analysisProgress(after)).toEqual({ selected: 2, analyzed: 0, failed: 1 });
    expect(analysisStatus(after)).toBe("partial");
    expect(isStaleResult(after, ref)).toBe(true);
  });

  it("distinguish recoverable errors from programming errors", async () => {
    const s = await confirmed();
    expect(hasRecoverableError(workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 0))))).toBe(true);
    expect(hasRecoverableError(workflowReducer(initialWorkflowState, { type: "stage/navigated", stage: "export" }))).toBe(false);
  });
});
