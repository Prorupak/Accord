import { afterEach, describe, expect, it, vi } from "vitest";
import { replayAudit } from "../domain/auditReplay";
import { candidatesFor } from "../domain/candidates";
import { prepareExport, type ModelRun } from "../domain/exportSnapshot";
import { pendingProposals, proposalStatus, unresolvedReason } from "../domain/reconcile";
import { activeRun, analysisProgress } from "../workflow/selectors";
import { decide, expectInvariants, rec, rowA, rowB } from "../workflow/testkit";
import { prepareConfirmation } from "../workflow/boundary";
import type { WorkflowAction } from "../workflow/types";
import type { AnalysisFailure } from "./contract";
import { startSuggestRun, type RunDeps } from "./runner";
import { abstain, apiError, fakeTransport, ids, ok, runningStore, suggestFirst, widgets } from "./testkit";

afterEach(() => vi.useRealTimers());

function harness(s: Awaited<ReturnType<typeof runningStore>>, opts: { ignoreAbort?: boolean; deps?: Partial<RunDeps> } = {}) {
  const t = fakeTransport({ ignoreAbort: opts.ignoreAbort });
  const records: ModelRun[] = [];
  const failures: AnalysisFailure[] = [];
  let clock = 1000;
  const exec = startSuggestRun(s.run, s, {
    transport: t.transport,
    newId: ids(),
    now: () => (clock += 25),
    onRecord: (r) => records.push(r),
    onFailure: (f) => failures.push(f),
    ...opts.deps,
  });
  return { t, exec, records, failures };
}

const types = (actions: WorkflowAction[]) => actions.map((a) => a.type).filter((t) => t.startsWith("analysis/") && t !== "analysis/started");
const status = (s: { getState: () => Parameters<typeof rec>[0] }) => rec(s.getState()).analysis.status;

describe("successful runs", () => {
  it("runs the canonical fixture in one request and completes", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    expect(call.request.rows.map((r) => r.left.rowId)).toEqual(s.run.selectedRowIds);
    call.resolve(ok(call.request));
    expect(await h.exec.done).toBe("completed");
    expect(status(s)).toBe("complete");
    expect(analysisProgress(s.getState())).toEqual({ selected: 2, analyzed: 2, failed: 0 });
    expect(pendingProposals(rec(s.getState()))).toHaveLength(2);
    expect(h.records).toEqual([
      { requestId: "req-1", provider: "openrouter", model: "test/model-1", promptVersion: "1", durationMs: 25, inputTokens: 100, outputTokens: 20, result: "valid" },
    ]);
    // No pair is ever accepted by the pipeline.
    expect(rec(s.getState()).acceptedPairs.every((p) => p.method === "exact_id")).toBe(true);
    expect(rec(s.getState()).decisions).toEqual([]);
    expectInvariants(s.getState());
  });

  it.each([1, 5, 6, 12, 20, 23])("splits %i eligible rows into sequential batches of five, at most four requests", async (n) => {
    const w = widgets(n);
    const s = await runningStore(w.a, w.b);
    const selected = Math.min(n, 20);
    expect(s.run.selectedRowIds).toHaveLength(selected);
    const h = harness(s);
    const batches = Math.ceil(selected / 5);
    for (let i = 1; i <= batches; i++) {
      const call = await h.t.call(i);
      expect(h.t.calls).toHaveLength(i); // the next request waits for this one
      expect(call.request.rows.length).toBeLessThanOrEqual(5);
      expect(call.request.rows.every((r) => r.candidates.length >= 1 && r.candidates.length <= 5)).toBe(true);
      call.resolve(ok(call.request, i % 2 ? suggestFirst : abstain));
    }
    expect(await h.exec.done).toBe("completed");
    expect(h.t.calls).toHaveLength(batches);
    expect(h.t.maxOpen).toBe(1);
    expect(new Set(h.t.calls.map((c) => c.request.requestId)).size).toBe(batches);
    expect(h.t.calls.flatMap((c) => c.request.rows.map((r) => r.left.rowId))).toEqual(s.run.selectedRowIds);
    expect(analysisProgress(s.getState())).toEqual({ selected, analyzed: selected, failed: 0 });
    expect(status(s)).toBe("complete");
    // Rows past the 20-row cap were never sent and say so.
    if (n > 20) expect(unresolvedReason(rec(s.getState()), rowA(s.getState(), 22)).reason).toBe("analysis_limit");
    expectInvariants(s.getState());
  });

  it("never sends quantities", async () => {
    const s = await runningStore("sku,item,qty\n,Organic cotton tote,987654\n", "code,desc,stock\n,Organic cotton bag,123456\n");
    const h = harness(s);
    const call = await h.t.call(1);
    expect(call.body).not.toContain("987654");
    expect(call.body).not.toContain("123456");
    call.resolve(ok(call.request));
    await h.exec.done;
  });

  it("treats a replayed batch as a no-op", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    call.resolve(ok(call.request));
    await h.exec.done;
    const received = s.actions.find((a) => a.type === "analysis/batchReceived")!;
    const before = s.getState();
    s.dispatch(received);
    expect(s.getState().reconciliation).toBe(before.reconciliation);
  });
});

describe("failures", () => {
  it("keeps the first batch when the provider fails on the second, then fails the run", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s);
    const first = await h.t.call(1);
    first.resolve(ok(first.request));
    const second = await h.t.call(2);
    second.resolve(apiError(502, "UPSTREAM_ERROR", second.request, { retryable: true }));
    expect(await h.exec.done).toBe("failed");
    expect(types(s.actions)).toEqual(["analysis/batchReceived", "analysis/batchFailed", "analysis/failed"]);
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 5, failed: 3 });
    expect(status(s)).toBe("failed");
    expect(rec(s.getState()).proposals).toHaveLength(5);
    expect(s.getState().error).toEqual({ kind: "analysis_failed", message: "The AI provider returned an error." });
    expect(h.records.map((r) => r.result)).toEqual(["valid", "failed"]);
    expect(h.records[1]).toMatchObject({ provider: "", model: "", promptVersion: "", inputTokens: null, outputTokens: null });
    expect(h.failures).toMatchObject([{ code: "UPSTREAM_ERROR", retryable: true, scope: "run", requestId: "req-2" }]);
    expectInvariants(s.getState());
  });

  it("continues after a batch-scoped invalid model output and settles as partial", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s);
    const first = await h.t.call(1);
    first.resolve(apiError(502, "MODEL_INVALID_OUTPUT", first.request));
    const second = await h.t.call(2);
    second.resolve(ok(second.request));
    expect(await h.exec.done).toBe("completed");
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 3, failed: 5 });
    expect(status(s)).toBe("partial");
    expect(unresolvedReason(rec(s.getState()), s.run.selectedRowIds[0]).reason).toBe("analysis_failed");
  });

  it("treats a substantively invalid 200 as a failed batch without manufacturing abstentions", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    call.resolve(ok(call.request, (row) => ({ ...suggestFirst(row), rightId: row.left.rowId })));
    await h.exec.done;
    expect(rec(s.getState()).proposals).toEqual([]);
    expect(analysisProgress(s.getState())).toEqual({ selected: 2, analyzed: 0, failed: 2 });
    expect(h.records[0]).toMatchObject({ result: "failed", model: "test/model-1" });
  });

  it.each([
    ["busy", () => apiError(409, "BUSY", null, { retryable: true }), "BUSY", true],
    ["rate limited", () => apiError(429, "RATE_LIMITED", null, { retryable: true, retryAfterSeconds: 3 }), "RATE_LIMITED", true],
    ["not configured", () => apiError(503, "NOT_CONFIGURED", null), "NOT_CONFIGURED", false],
    ["malformed", () => ({ status: 200, body: "{not json" }), "MALFORMED_RESPONSE", false],
  ] as const)("stops on %s without retrying", async (_l, response, code, retryable) => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s);
    (await h.t.call(1)).resolve(response());
    expect(await h.exec.done).toBe("failed");
    expect(h.t.calls).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ code, retryable });
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 0, failed: 5 });
    // Unreached rows are not counted as failed requests but are explained by the failed run.
    expect(unresolvedReason(rec(s.getState()), s.run.selectedRowIds[7]).reason).toBe("analysis_failed");
  });

  it("reports a network failure", async () => {
    const s = await runningStore();
    const h = harness(s);
    (await h.t.call(1)).reject(new TypeError("Failed to fetch"));
    expect(await h.exec.done).toBe("failed");
    expect(h.failures[0]).toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("stops at the client deadline, fails the in-flight batch and keeps earlier results", async () => {
    vi.useFakeTimers();
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s, { deps: { runDeadlineMs: 1000 } });
    const first = await h.t.call(1);
    first.resolve(ok(first.request));
    await h.t.call(2); // never answered
    await vi.advanceTimersByTimeAsync(1000);
    expect(await h.exec.done).toBe("deadline");
    expect(types(s.actions)).toEqual(["analysis/batchReceived", "analysis/batchFailed", "analysis/completed"]);
    expect(status(s)).toBe("partial");
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 5, failed: 3 });
    expect(h.records.map((r) => r.result)).toEqual(["valid", "failed"]);
    expect(h.failures[0]).toMatchObject({ code: "CLIENT_DEADLINE" });
  });
});

describe("cancellation", () => {
  it("cancels during a request: aborts, settles once and ignores the late response", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s, { ignoreAbort: true });
    const first = await h.t.call(1);
    first.resolve(ok(first.request));
    const second = await h.t.call(2);
    h.exec.cancel();
    h.exec.cancel();
    expect(second.signal.aborted).toBe(true);
    const cancelled = s.getState();
    expect(rec(cancelled).analysis).toMatchObject({ status: "cancelled", analyzedRowIds: s.run.selectedRowIds.slice(0, 5), failedRowIds: [] });
    second.resolve(ok(second.request)); // the server answered anyway
    expect(await h.exec.done).toBe("cancelled");
    expect(s.getState().reconciliation).toBe(cancelled.reconciliation);
    expect(types(s.actions)).toEqual(["analysis/batchReceived", "analysis/cancelled"]);
    expect(h.t.calls).toHaveLength(2);
    expect(h.records.map((r) => r.result)).toEqual(["valid", "cancelled"]);
    expect(unresolvedReason(rec(s.getState()), s.run.selectedRowIds[6]).reason).toBe("analysis_cancelled");
    // Partial export stays possible.
    expect(prepareExport(rec(s.getState()), { appVersion: "t", generatedAt: "t", runId: "t", modelRuns: h.records }).ok).toBe(true);
  });

  it("cancels while the next request is being prepared; nothing more is sent", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    let reads = -1;
    let cancel = () => {};
    const io = {
      dispatch: s.dispatch,
      getState: () => {
        // After the first response: 1 = post-response check, 2 = next-batch check, 3 = preparation.
        if (reads >= 0 && ++reads === 3) cancel();
        return s.getState();
      },
    };
    const t = fakeTransport();
    const exec = startSuggestRun(s.run, io, { transport: t.transport, newId: ids(), now: () => 0 });
    cancel = exec.cancel;
    const first = await t.call(1);
    reads = 0;
    first.resolve(ok(first.request));
    expect(await exec.done).toBe("cancelled");
    expect(t.calls).toHaveLength(1);
    expect(status(s)).toBe("cancelled");
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 5, failed: 0 });
  });

  it("cancels before anything is sent when the run is cancelled immediately", async () => {
    const s = await runningStore();
    const h = harness(s);
    h.exec.cancel();
    expect(await h.exec.done).toBe("cancelled");
    expect(h.t.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(rec(s.getState()).proposals).toEqual([]);
  });

  it("cancels between batches", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s);
    const first = await h.t.call(1);
    first.resolve(ok(first.request));
    await vi.waitFor(() => expect(h.t.calls).toHaveLength(2));
    h.exec.cancel();
    expect(await h.exec.done).toBe("cancelled");
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 5, failed: 0 });
  });

  it("lets cancellation win a race with a response resolved in the same tick", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    call.resolve(ok(call.request));
    h.exec.cancel(); // before the runner's continuation validates and dispatches
    expect(await h.exec.done).toBe("cancelled");
    expect(rec(s.getState()).proposals).toEqual([]);
    expect(types(s.actions)).toEqual(["analysis/cancelled"]);
  });

  it("is a no-op after the run completed", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    call.resolve(ok(call.request));
    await h.exec.done;
    const after = s.getState();
    h.exec.cancel();
    expect(s.getState()).toBe(after);
    expect(status(s)).toBe("complete");
  });
});

describe("staleness and human decisions", () => {
  it("drops a late response after reconfiguration and stops scheduling", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const h = harness(s, { ignoreAbort: true });
    const call = await h.t.call(1);
    s.dispatch({ type: "draft/optionSet", option: "idCaseSensitive", value: false });
    const confirmation = await prepareConfirmation(s.getState());
    if (!confirmation.ok) throw new Error("confirmation failed");
    s.dispatch(confirmation.action);
    expect(rec(s.getState()).analysis.status).toBe("idle");
    call.resolve(ok(call.request));
    expect(await h.exec.done).toBe("superseded");
    expect(h.t.calls).toHaveLength(1);
    expect(rec(s.getState()).proposals).toEqual([]);
    expect(h.records[0].result).toBe("cancelled");
  });

  it("keeps a manual acceptance made while the request was in flight", async () => {
    const s = await runningStore();
    const h = harness(s);
    const call = await h.t.call(1);
    const [tote, cup] = [rowA(s.getState(), 1), rowA(s.getState(), 3)];
    s.dispatch(decide(s.getState(), "accept", tote, rowB(s.getState(), 1)));
    s.dispatch(decide(s.getState(), "reject", cup, rowB(s.getState(), 3)));
    call.resolve(ok(call.request)); // suggests tote→bag and cup→tumbler
    expect(await h.exec.done).toBe("completed");
    const r = rec(s.getState());
    expect(r.acceptedPairs.filter((p) => p.method === "manual")).toHaveLength(1);
    expect(r.proposals.map((p) => proposalStatus(r, p))).toEqual(["unavailable", "rejected"]);
    expect(pendingProposals(r)).toEqual([]);
    expectInvariants(s.getState());
  });

  it("skips rows a human resolved before their batch is sent and still completes", async () => {
    const w = widgets(8, 1); // every A row has the same single candidate
    const s = await runningStore(w.a, w.b);
    const h = harness(s);
    const first = await h.t.call(1);
    // Accepting row 0 with the only B row leaves rows 1..7 without candidates.
    s.dispatch(decide(s.getState(), "accept", rowA(s.getState(), 0), rowB(s.getState(), 0)));
    first.resolve(ok(first.request));
    expect(await h.exec.done).toBe("completed");
    expect(h.t.calls).toHaveLength(1);
    const r = rec(s.getState());
    expect(analysisProgress(s.getState())).toEqual({ selected: 8, analyzed: 5, failed: 0 });
    expect(r.analysis.status).toBe("complete");
    for (const id of s.run.selectedRowIds.slice(5)) {
      expect(candidatesFor(r, id)).toEqual([]);
      expect(unresolvedReason(r, id).reason).toBe("no_candidates");
    }
    expectInvariants(s.getState());
  });

  it("ignores everything from an earlier run once a new run has started", async () => {
    const w = widgets(8);
    const s = await runningStore(w.a, w.b);
    const one = harness(s, { ignoreAbort: true });
    const old = await one.t.call(1);
    one.exec.cancel();
    s.dispatch({ type: "analysis/started" });
    const run2 = activeRun(s.getState())!;
    expect(run2.generation).toBeGreaterThan(s.run.generation);
    old.resolve(ok(old.request));
    expect(await one.exec.done).toBe("cancelled");
    const two = harness({ ...s, run: run2 });
    const fresh = await two.t.call(1);
    expect(fresh.request.generation).toBe(run2.generation);
    expect(rec(s.getState()).proposals).toEqual([]);
    fresh.resolve(ok(fresh.request));
    const next = await two.t.call(2);
    next.resolve(ok(next.request));
    expect(await two.exec.done).toBe("completed");
    expect(rec(s.getState()).proposals.every((p) => p.generation === run2.generation)).toBe(true);
  });
});

describe("clipped context", () => {
  const long = (tag: string) => `Organic cotton tote ${tag} `.repeat(9).trim();

  it("accepts clipped citations, keeps full cells and replays the audit", async () => {
    // Only the abstention cites clipped text; the suggestion pair is short on both sides.
    const s = await runningStore(`sku,item,qty\n,${long("a")},1\n,Ceramic mug white,2\n`, `code,desc,stock\n,${long("b")},1\n,White ceramic mug,2\n`);
    const h = harness(s);
    const call = await h.t.call(1);
    const clippedLeft = call.request.rows[0].left.fields[0].value;
    expect(Array.from(clippedLeft)).toHaveLength(160);
    call.resolve(ok(call.request, (row) => (row === call.request.rows[0] ? { ...abstain(row), reasonCode: "ambiguous", evidence: [row.left.fields[0], row.candidates[0].fields[0]] } : suggestFirst(row))));
    await h.exec.done;
    const r = rec(s.getState());
    expect(analysisProgress(s.getState())).toEqual({ selected: 2, analyzed: 2, failed: 0 });
    // The audit records what the model saw; the full original cell is still in the dataset.
    expect(r.proposals[0].evidence[0].value).toBe(clippedLeft);
    expect(r.context.rows.get(r.proposals[0].leftId)!.name).toBe(long("a"));
    const snap = prepareExport(r, { appVersion: "t", generatedAt: "t", runId: "t", modelRuns: h.records });
    if (!snap.ok) throw new Error("export failed");
    const replay = await replayAudit(JSON.parse(snap.snapshot.files["audit.json"]));
    expect(replay.ok).toBe(true);
  });

  it("fails closed on a suggestion whose identity text was clipped", async () => {
    const s = await runningStore(`sku,item,qty\n,${long("a")},1\n`, `code,desc,stock\n,${long("b")},1\n`);
    const h = harness(s);
    const call = await h.t.call(1);
    call.resolve(ok(call.request)); // well-formed, cites the exact clipped values
    await h.exec.done;
    const r = rec(s.getState());
    expect(r.proposals).toEqual([]);
    expect(analysisProgress(s.getState())).toEqual({ selected: 1, analyzed: 0, failed: 1 });
    expect(unresolvedReason(r, rowA(s.getState(), 0))).toMatchObject({ reason: "analysis_failed" });
    expect(h.records[0].result).toBe("valid"); // the transport result was valid; the domain declined it
  });
});
