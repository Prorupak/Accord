import { describe, expect, it } from "vitest";
import { dataset } from "../domain/testkit";
import { prepareConfirmation } from "./boundary";
import { analysisStatus, canEnterStage, counts } from "./selectors";
import {
  SOURCE_A,
  SOURCE_B,
  confirm,
  confirmed,
  decide,
  expectInvariants,
  load,
  loaded,
  mapBoth,
  rec,
  reduce,
  rowA,
  rowB,
} from "./testkit";
import type { WorkflowAction, WorkflowState } from "./types";
import { initialWorkflowState, workflowReducer } from "./workflowReducer";

const OTHER_B = SOURCE_B.replace("White ceramic mug,5", "White ceramic mug,7");

describe("initial state", () => {
  it("starts at import with nothing loaded, confirmed, running or derived", () => {
    const s = initialWorkflowState;
    expect(s.stage).toBe("import");
    expect(s.sources).toEqual({ A: { dataset: null, pendingToken: null }, B: { dataset: null, pendingToken: null } });
    expect(s.draft.A).toEqual({ productId: null, name: null, quantity: null, unit: null });
    expect(s.draft.idCaseSensitive).toBe(true);
    expect(s.reconciliation).toBeNull();
    expect(s.error).toBeNull();
    expect(analysisStatus(s)).toBe("idle");
    expect(counts(s)).toBeNull();
    expect(Object.keys(s).sort()).toEqual(["draft", "error", "reconciliation", "sources", "stage"]);
  });
});

describe("dataset lifecycle", () => {
  it("loads each side independently and unlocks mapping once both exist", async () => {
    const a = await load(initialWorkflowState, "A", SOURCE_A);
    expect(a.sources.A.dataset?.rows).toHaveLength(4);
    expect(a.sources.B.dataset).toBeNull();
    expect(canEnterStage(a, "mapping")).toBe(false);
    const ab = await load(a, "B", SOURCE_B);
    expect(ab.sources.A.dataset).toBe(a.sources.A.dataset);
    expect(ab.sources.B.pendingToken).toBeNull();
    expect(canEnterStage(ab, "mapping")).toBe(true);
  });

  it("ignores an older import that finishes after a newer one (A1 started, A2 started, A2 done, A1 done)", async () => {
    const a1 = await dataset("A", SOURCE_A);
    const a2 = await dataset("A", SOURCE_A.replace("Travel cup blue", "Travel cup red"));
    let s = reduce(initialWorkflowState, { type: "import/started", side: "A", token: "a1" }, { type: "import/started", side: "A", token: "a2" });
    s = workflowReducer(s, { type: "import/succeeded", side: "A", token: "a2", dataset: a2 });
    const late = workflowReducer(s, { type: "import/succeeded", side: "A", token: "a1", dataset: a1 });
    expect(late).toBe(s);
    expect(late.sources.A.dataset).toBe(a2);
    const lateFailure = workflowReducer(s, { type: "import/failed", side: "A", token: "a1", error: { code: "empty_file", message: "x" } });
    expect(lateFailure).toBe(s);
  });

  it("keeps the previous dataset and reports a typed error when the current import fails", async () => {
    const s = await load(initialWorkflowState, "A", SOURCE_A);
    const next = reduce(
      s,
      { type: "import/started", side: "A", token: "bad" },
      { type: "import/failed", side: "A", token: "bad", error: { code: "row_width", message: "Row has the wrong width.", recordIndex: 2 } },
    );
    expect(next.sources.A).toEqual({ dataset: s.sources.A.dataset, pendingToken: null });
    expect(next.error).toEqual({ kind: "import_failed", side: "A", error: { code: "row_width", message: "Row has the wrong width.", recordIndex: 2 } });
  });

  it("drops an in-flight import when its side is cleared", async () => {
    const d = await dataset("A", SOURCE_A);
    const s = reduce(initialWorkflowState, { type: "import/started", side: "A", token: "t" }, { type: "source/cleared", side: "A" });
    expect(workflowReducer(s, { type: "import/succeeded", side: "A", token: "t", dataset: d })).toBe(s);
  });

  it("rejects a dataset parsed for the other side as a programming error", async () => {
    const b = await dataset("B", SOURCE_B);
    const s = reduce(initialWorkflowState, { type: "import/started", side: "A", token: "t" }, { type: "import/succeeded", side: "A", token: "t", dataset: b });
    expect(s.sources.A.dataset).toBeNull();
    expect(s.error).toMatchObject({ kind: "invalid_transition", action: "import/succeeded" });
  });

  it.each([
    ["replacing", async (s: WorkflowState) => load(s, "B", OTHER_B)],
    ["clearing", async (s: WorkflowState) => workflowReducer(s, { type: "source/cleared", side: "B" })],
  ])("%s one source discards confirmation, decisions and analysis but keeps the other source", async (_l, change) => {
    let s = await confirmed();
    s = reduce(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)), { type: "analysis/started" });
    expect(rec(s).decisions).toHaveLength(1);
    const next = await change(s);
    expect(next.reconciliation).toBeNull();
    expect(next.stage).toBe("import");
    expect(next.sources.A).toBe(s.sources.A);
    expect(next.draft.A).toBe(s.draft.A);
    expect(next.draft.B).toEqual({ productId: null, name: null, quantity: null, unit: null });
  });

  it("resets to the initial state", async () => {
    expect(workflowReducer(await confirmed(), { type: "workflow/reset" })).toBe(initialWorkflowState);
  });
});

describe("mapping lifecycle", () => {
  it("confirms a valid configuration, runs exact matching and enters review", async () => {
    const s = await confirmed();
    expect(s.stage).toBe("review");
    expect(rec(s).revision).toBe(0);
    expect(rec(s).acceptedPairs.map((p) => p.method)).toEqual(["exact_id", "exact_id"]);
    expectInvariants(s);
  });

  it.each([
    ["missing required name", { name: null }, "required"],
    ["duplicate mapped column", { quantity: "c1" }, "column_reused"],
    ["unknown column", { name: "c9" }, "unknown_column"],
  ])("refuses to confirm with a %s", async (_l, patch, code) => {
    const valid = await loaded();
    const forged = await prepareConfirmation(valid);
    if (!forged.ok) throw new Error("fixture");
    const bad = mapBoth(valid, { productId: "c0", name: "c1", quantity: "c2", unit: null, ...patch });
    const prepared = await prepareConfirmation(bad);
    expect(prepared).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code })]) });
    // A confirmation computed before the draft broke must not slip through.
    const after = workflowReducer(bad, forged.action);
    expect(after.reconciliation).toBeNull();
    expect(after.error).toMatchObject({ kind: "invalid_configuration" });
  });

  it("refuses confirmation without both sources", async () => {
    const s = await load(initialWorkflowState, "A", SOURCE_A);
    expect(await prepareConfirmation(s)).toEqual({ ok: false, errors: null });
    const forged = await prepareConfirmation(await loaded());
    if (!forged.ok) throw new Error("fixture");
    expect(workflowReducer(s, forged.action).error).toMatchObject({ kind: "missing_prerequisite" });
  });

  it("rejects a confirmation whose draft changed while hashing", async () => {
    const s = await loaded();
    const prepared = await prepareConfirmation(s);
    if (!prepared.ok) throw new Error("fixture");
    const edited = workflowReducer(s, { type: "draft/optionSet", option: "idCaseSensitive", value: false });
    const after = workflowReducer(edited, prepared.action);
    expect(after.reconciliation).toBeNull();
    expect(after.error).toMatchObject({ kind: "stale_configuration" });
  });

  it("rejects a confirmation prepared before a source was replaced and remapped", async () => {
    const s = await loaded();
    const prepared = await prepareConfirmation(s);
    if (!prepared.ok) throw new Error("fixture");
    const replaced = mapBoth(await load(s, "B", OTHER_B));
    const after = workflowReducer(replaced, prepared.action);
    expect(after.reconciliation).toBeNull();
    expect(after.error).toMatchObject({ kind: "stale_configuration" });
    expect((await confirm(replaced)).reconciliation).not.toBeNull();
  });

  it("re-confirming a changed configuration replaces reconciliation and drops every decision", async () => {
    let s = await confirmed();
    s = workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)));
    const old = rec(s).context.configurationHash;
    const edited = workflowReducer(s, { type: "draft/optionSet", option: "idCaseSensitive", value: false });
    expect(edited.reconciliation).toBe(s.reconciliation); // a draft edit alone changes nothing confirmed
    const next = await confirm(edited);
    expect(rec(next).context.configurationHash).not.toBe(old);
    expect(rec(next).decisions).toEqual([]);
    expect(rec(next).acceptedPairs.every((p) => p.method === "exact_id")).toBe(true);
    expectInvariants(next);
  });

  it("re-confirming the identical configuration keeps decisions", async () => {
    let s = await confirmed();
    s = workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)));
    const again = await confirm(s);
    expect(again.reconciliation).toBe(s.reconciliation);
  });

  it("treats a redundant draft edit as no change", async () => {
    const s = await loaded();
    expect(workflowReducer(s, { type: "draft/fieldMapped", side: "A", field: "name", columnId: "c1" })).toBe(s);
    expect(workflowReducer(s, { type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: true })).toBe(s);
  });
});

describe("decision routing", () => {
  it("rejects decisions before mappings are confirmed", async () => {
    const s = await loaded();
    const c = await confirmed();
    const after = workflowReducer(s, decide(c, "accept", rowA(c, 1), rowB(c, 1)));
    expect(after.error).toMatchObject({ kind: "missing_prerequisite" });
  });

  it.each<[string, (s: WorkflowState) => WorkflowAction[], (s: WorkflowState) => void]>([
    ["accept (manual)", (s) => [decide(s, "accept", rowA(s, 1), rowB(s, 1))], (s) => expect(rec(s).acceptedPairs.at(-1)).toMatchObject({ method: "manual" })],
    ["reject", (s) => [decide(s, "reject", rowA(s, 3), rowB(s, 3))], (s) => expect(rec(s).rejectedPairs).toHaveLength(1)],
    ["defer", (s) => [decide(s, "defer", rowA(s, 3), null)], (s) => expect(rec(s).decisions.at(-1)?.action).toBe("defer")],
    [
      "exclude exact",
      (s) => [decide(s, "exclude_exact", rowA(s, 0), rowB(s, 0))],
      (s) => expect(rec(s).excludedExactPairs).toEqual([{ leftId: rowA(s, 0), rightId: rowB(s, 0) }]),
    ],
  ])("%s delegates to applyDecision and bumps revision once", async (_l, actions, check) => {
    const s = await confirmed();
    const next = reduce(s, ...actions(s));
    expect(rec(next).revision).toBe(rec(s).revision + 1);
    expect(next.error).toBeNull();
    check(next);
    expectInvariants(next);
  });

  it("undo reverses an accept and restores an excluded exact pair, which then stays excluded until undone", async () => {
    let s = await confirmed();
    s = reduce(s, decide(s, "accept", rowA(s, 1), rowB(s, 1)), decide(s, "undo", rowA(s, 1), rowB(s, 1)));
    expect(counts(s)?.matched).toBe(2);
    s = workflowReducer(s, decide(s, "exclude_exact", rowA(s, 0), rowB(s, 0)));
    s = reduce(s, { type: "analysis/started" });
    expect(rec(s).acceptedPairs.some((p) => p.leftId === rowA(s, 0))).toBe(false);
    s = workflowReducer(s, decide(s, "undo", rowA(s, 0), rowB(s, 0)));
    expect(rec(s).acceptedPairs.some((p) => p.leftId === rowA(s, 0) && p.method === "exact_id")).toBe(true);
    expectInvariants(s);
  });

  it("keeps reconciliation untouched and reports a typed error for an invalid pair", async () => {
    const s = await confirmed();
    const after = workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 0)));
    expect(after.reconciliation).toBe(s.reconciliation);
    expect(after.error).toEqual({ kind: "decision_rejected", error: { code: "unavailable", message: expect.any(String) } });
  });

  it("is idempotent for a repeated decision ID and rejects a conflicting reuse", async () => {
    const s = await confirmed();
    const accept = decide(s, "accept", rowA(s, 1), rowB(s, 1));
    const once = workflowReducer(s, accept);
    expect(workflowReducer(once, accept)).toBe(once);
    expect(rec(once).acceptedPairs).toHaveLength(3);
    if (accept.type !== "decision/requested") throw new Error("fixture");
    const conflicting = workflowReducer(once, { ...accept, decision: { ...accept.decision, action: "reject" } });
    expect(conflicting.reconciliation).toBe(once.reconciliation);
    expect(conflicting.error).toMatchObject({ error: { code: "decision_id_conflict" } });
  });

  it("clears the error of a failed decision when a valid one follows", async () => {
    const s = await confirmed();
    const failed = workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 0)));
    const ok = workflowReducer(failed, decide(s, "accept", rowA(s, 1), rowB(s, 1)));
    expect(ok.error).toBeNull();
    expect(rec(ok).revision).toBe(rec(s).revision + 1);
  });

  it("rejects a decision made against an earlier configuration", async () => {
    const s = await confirmed();
    const stale = decide(s, "accept", rowA(s, 1), rowB(s, 1));
    const next = await confirm(workflowReducer(s, { type: "draft/optionSet", option: "idCaseSensitive", value: false }));
    expect(workflowReducer(next, stale).error).toMatchObject({ error: { code: "stale_configuration" } });
  });
});

describe("navigation and display state", () => {
  it("guards stages and never changes revision", async () => {
    expect(workflowReducer(initialWorkflowState, { type: "stage/navigated", stage: "review" }).error).toMatchObject({ kind: "invalid_transition" });
    const s = await confirmed();
    const exported = workflowReducer(s, { type: "stage/navigated", stage: "export" });
    expect(exported.stage).toBe("export");
    expect(exported.reconciliation).toBe(s.reconciliation);
    const dismissed = workflowReducer(workflowReducer(s, decide(s, "accept", rowA(s, 1), rowB(s, 0))), { type: "error/dismissed" });
    expect(dismissed.error).toBeNull();
    expect(dismissed.reconciliation).toBe(s.reconciliation);
    expect(workflowReducer(dismissed, { type: "error/dismissed" })).toBe(dismissed);
  });
});

describe("purity", () => {
  it("never mutates its inputs and is deterministic", async () => {
    const start = await confirmed();
    const actions: WorkflowAction[] = [
      decide(start, "accept", rowA(start, 1), rowB(start, 1)),
      decide(start, "exclude_exact", rowA(start, 0), rowB(start, 0)),
      { type: "analysis/started" },
      { type: "analysis/cancelled", generation: 1, configurationHash: rec(start).context.configurationHash },
      { type: "draft/optionSet", option: "idCaseSensitive", value: false },
      { type: "source/cleared", side: "A" },
    ];
    let s = start;
    const states: WorkflowState[] = [];
    for (const action of actions) {
      const before = structuredClone(s);
      const actionBefore = structuredClone(action);
      const next = workflowReducer(s, action);
      expect(s).toEqual(before);
      expect(action).toEqual(actionBefore);
      states.push(next);
      s = next;
    }
    expect(actions.reduce(workflowReducer, start)).toEqual(states.at(-1));
  });
});
