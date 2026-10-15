import { describe, expect, it } from "vitest";
import { proposalStatus, unresolvedReason } from "../domain/reconcile";
import { activeRun, analysisProgress, counts, isStaleResult } from "./selectors";
import { batch, confirm, confirmed, decide, expectInvariants, loaded, rec, reduce, rowA, rowB, runRef, suggestion } from "./testkit";
import type { WorkflowState } from "./types";
import { workflowReducer } from "./workflowReducer";

const started = async () => workflowReducer(await confirmed(), { type: "analysis/started" });

// Tote → bag is valid; the travel-cup proposal cites a value that is not in the source cell.
const mixedBatch = (s: WorkflowState) =>
  batch(s, "r1", [
    suggestion(s, rowA(s, 1), rowB(s, 1)),
    { ...suggestion(s, rowA(s, 3), rowB(s, 3)), evidence: [{ side: "A", rowId: rowA(s, 3), columnId: "c1", value: "invented" }] },
  ]);

describe("starting analysis", () => {
  it("requires confirmed mappings", async () => {
    const s = await loaded();
    expect(workflowReducer(s, { type: "analysis/started" }).error).toMatchObject({ kind: "missing_prerequisite" });
  });

  it("advances the generation, selects eligible rows and preserves pairs and decisions", async () => {
    let s = await confirmed();
    s = workflowReducer(s, decide(s, "exclude_exact", rowA(s, 0), rowB(s, 0)));
    const next = workflowReducer(s, { type: "analysis/started" });
    expect(rec(next).generation).toBe(rec(s).generation + 1);
    expect(rec(next).analysis).toEqual({ status: "running", selectedRowIds: [rowA(s, 1), rowA(s, 3)], analyzedRowIds: [], failedRowIds: [] });
    expect(rec(next).decisions).toBe(rec(s).decisions);
    expect(rec(next).acceptedPairs).toBe(rec(s).acceptedPairs);
    expect(activeRun(next)).toEqual({ ...runRef(next), selectedRowIds: [rowA(s, 1), rowA(s, 3)] });
  });

  it("refuses a second start while running", async () => {
    const s = await started();
    const again = workflowReducer(s, { type: "analysis/started" });
    expect(again.reconciliation).toBe(s.reconciliation);
    expect(again.error).toMatchObject({ kind: "invalid_transition" });
  });

  it("refuses to start when no row has candidates", async () => {
    let s = await confirmed();
    s = reduce(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)), decide(s, "accept", rowA(s, 3), rowB(s, 3)));
    expect(workflowReducer(s, { type: "analysis/started" }).error).toMatchObject({ kind: "missing_prerequisite" });
  });
});

describe("batches", () => {
  it("adds validated proposals and counts only retained rows as analyzed", async () => {
    const s = await started();
    const next = workflowReducer(s, mixedBatch(s));
    expect(rec(next).proposals.map((p) => p.leftId)).toEqual([rowA(s, 1)]);
    expect(rec(next).analysis.analyzedRowIds).toEqual([rowA(s, 1)]);
    expect(rec(next).analysis.failedRowIds).toEqual([rowA(s, 3)]);
    expect(counts(next)?.needsReview).toBe(1);
    expectInvariants(next);
  });

  it("counts a requested row missing from the response as failed", async () => {
    const s = await started();
    const next = workflowReducer(s, batch(s, "r1", [suggestion(s, rowA(s, 1), rowB(s, 1))], [rowA(s, 1), rowA(s, 3)]));
    expect(analysisProgress(next)).toEqual({ selected: 2, analyzed: 1, failed: 1 });
  });

  it("treats a duplicate batch as a no-op", async () => {
    const s = await started();
    const once = workflowReducer(s, mixedBatch(s));
    expect(workflowReducer(once, mixedBatch(s))).toBe(once);
  });

  it.each([
    ["an older generation", (s: WorkflowState) => ({ generation: rec(s).generation - 1 })],
    ["another configuration hash", () => ({ configurationHash: "0".repeat(64) })],
  ])("ignores a batch from %s", async (_l, patch) => {
    const s = await started();
    const b = mixedBatch(s);
    if (b.type !== "analysis/batchReceived") throw new Error("fixture");
    expect(workflowReducer(s, { ...b, batch: { ...b.batch, ...patch(s) } })).toBe(s);
  });

  it("rejects a batch for rows outside the run as a programming error", async () => {
    const s = await started();
    const after = workflowReducer(s, batch(s, "r1", [], [rowA(s, 0)]));
    expect(after.reconciliation).toBe(s.reconciliation);
    expect(after.error).toMatchObject({ kind: "invalid_transition" });
  });

  it("records a failed request without counting it as analysis", async () => {
    const s = await started();
    const next = workflowReducer(s, { type: "analysis/batchFailed", ...runRef(s), rowIds: [rowA(s, 1)] });
    expect(analysisProgress(next)).toEqual({ selected: 2, analyzed: 0, failed: 1 });
    expect(workflowReducer(next, { type: "analysis/batchFailed", ...runRef(s), rowIds: [rowA(s, 1)] })).toBe(next);
  });
});

describe("terminal transitions", () => {
  it("completes as `complete` when every selected row was analyzed", async () => {
    let s = await started();
    s = workflowReducer(s, batch(s, "r1", [suggestion(s, rowA(s, 1), rowB(s, 1)), suggestion(s, rowA(s, 3), rowB(s, 3))]));
    const ref = runRef(s);
    const done = workflowReducer(s, { type: "analysis/completed", ...ref });
    expect(rec(done).analysis.status).toBe("complete");
    expect(rec(done).generation).toBe(ref.generation + 1);
    expect(isStaleResult(done, ref)).toBe(true);
    expect(workflowReducer(done, { type: "analysis/completed", ...ref })).toBe(done);
    expect(workflowReducer(done, { type: "analysis/failed", ...ref, message: "late" })).toBe(done);
  });

  it("completes as `partial` when rows failed, keeping the real counts", async () => {
    const s = await started();
    const done = reduce(s, mixedBatch(s), { type: "analysis/completed", ...runRef(s) });
    expect(rec(done).analysis).toMatchObject({ status: "partial", analyzedRowIds: [rowA(s, 1)], failedRowIds: [rowA(s, 3)] });
  });

  it("cancellation keeps completed work and decisions and blocks later batches", async () => {
    let s = await started();
    s = workflowReducer(s, decide(s, "exclude_exact", rowA(s, 0), rowB(s, 0)));
    s = workflowReducer(s, batch(s, "r1", [suggestion(s, rowA(s, 1), rowB(s, 1))], [rowA(s, 1)]));
    const ref = runRef(s);
    const cancelled = workflowReducer(s, { type: "analysis/cancelled", ...ref });
    expect(rec(cancelled).analysis).toMatchObject({ status: "cancelled", analyzedRowIds: [rowA(s, 1)], failedRowIds: [] });
    expect(rec(cancelled).proposals).toBe(rec(s).proposals);
    expect(rec(cancelled).decisions).toBe(rec(s).decisions);
    expect(unresolvedReason(rec(cancelled), rowA(s, 3)).reason).toBe("analysis_cancelled");
    const late = { type: "analysis/batchReceived" as const, batch: { requestId: "r2", ...ref, proposals: [suggestion(s, rowA(s, 3), rowB(s, 3))] }, rowIds: [rowA(s, 3)] };
    expect(workflowReducer(cancelled, late)).toBe(cancelled);
    // Review stays possible after cancellation.
    const accepted = workflowReducer(cancelled, decide(s, "accept", rowA(s, 1), rowB(s, 1), { proposalId: rec(s).proposals[0].id }));
    expect(rec(accepted).acceptedPairs.at(-1)).toMatchObject({ method: "ai_reviewed" });
    expectInvariants(accepted);
  });

  it("failure keeps pairs, decisions, proposals and accounting, marks unprocessed rows and shows an error", async () => {
    let s = await started();
    s = workflowReducer(s, batch(s, "r1", [suggestion(s, rowA(s, 1), rowB(s, 1))], [rowA(s, 1)]));
    s = workflowReducer(s, decide(s, "reject", rowA(s, 1), rowB(s, 1)));
    const failed = workflowReducer(s, { type: "analysis/failed", ...runRef(s), message: "The model service is unavailable." });
    expect(rec(failed).analysis).toMatchObject({ status: "failed", analyzedRowIds: [rowA(s, 1)], failedRowIds: [rowA(s, 3)] });
    expect(rec(failed).acceptedPairs).toBe(rec(s).acceptedPairs);
    expect(rec(failed).decisions).toBe(rec(s).decisions);
    expect(rec(failed).proposals).toBe(rec(s).proposals);
    expect(failed.error).toEqual({ kind: "analysis_failed", message: "The model service is unavailable." });
    expectInvariants(failed);
    // A new run clears the task error and keeps human decisions.
    const rerun = workflowReducer(failed, { type: "analysis/started" });
    expect(rerun.error).toBeNull();
    expect(rec(rerun).decisions).toBe(rec(s).decisions);
  });
});

describe("races", () => {
  it("drops an old batch after reconfiguration even when the new run reuses its generation number", async () => {
    const s = await started();
    const old = mixedBatch(s);
    const reconfigured = await confirm(workflowReducer(s, { type: "draft/optionSet", option: "idCaseSensitive", value: false }));
    const rerun = workflowReducer(reconfigured, { type: "analysis/started" });
    expect(rec(rerun).generation).toBe(rec(s).generation);
    expect(workflowReducer(rerun, old)).toBe(rerun);
  });

  it("ignores the previous run's completion after a new run starts", async () => {
    const s = await started();
    const first = runRef(s);
    const second = reduce(s, { type: "analysis/cancelled", ...first }, { type: "analysis/started" });
    expect(workflowReducer(second, { type: "analysis/completed", ...first })).toBe(second);
    expect(rec(second).analysis.status).toBe("running");
  });

  it("keeps a human decision made while a batch is in flight; the late proposal becomes unavailable", async () => {
    let s = await started();
    const pending = batch(s, "r1", [suggestion(s, rowA(s, 1), rowB(s, 1))], [rowA(s, 1)]);
    s = workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)));
    const after = workflowReducer(s, pending);
    expect(rec(after).acceptedPairs.at(-1)).toMatchObject({ leftId: rowA(s, 1), method: "manual" });
    expect(proposalStatus(rec(after), rec(after).proposals[0])).toBe("unavailable");
    expect(counts(after)?.needsReview).toBe(0);
    expectInvariants(after);
  });

  it("does not let stale lifecycle events replace a useful current error", async () => {
    let s = await started();
    const ref = runRef(s);
    s = reduce(s, { type: "analysis/cancelled", ...ref }, decide(s, "accept", rowA(s, 1), rowB(s, 0)));
    const error = s.error;
    expect(error).toMatchObject({ kind: "decision_rejected" });
    expect(workflowReducer(s, { type: "analysis/failed", ...ref, message: "late" }).error).toBe(error);
  });
});
