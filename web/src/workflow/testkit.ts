// Test-only helpers: drive the workflow reducer through the real boundary helpers.
import { expect } from "vitest";
import { checkInvariants } from "../domain/invariants";
import type { DraftMapping } from "../domain/mapping";
import type { IncomingProposal, ReconciliationState } from "../domain/reconcile";
import { ID_NAME_QTY } from "../domain/testkit";
import type { DecisionAction, RowId, Side, UserDecision } from "../domain/types";
import { parseSource, prepareConfirmation } from "./boundary";
import type { RunRef, WorkflowAction, WorkflowState } from "./types";
import { initialWorkflowState, workflowReducer } from "./workflowReducer";

// The canonical fixture (spec §13.1): P01 and P03 pair by ID; tote and travel cup need review.
export const SOURCE_A = "sku,item,qty\nP01,Stainless steel flask 750ml,12\n,Organic cotton tote natural,8\nP03,Ceramic mug white,6\n,Travel cup blue,4\n";
export const SOURCE_B = "product_code,description,stock\nP01,S/S bottle 750 ml,12\n,Natural cotton shopping bag,8\nP03,White ceramic mug,5\n,Travel tumbler blue 350ml,4\n";

export const reduce = (state: WorkflowState, ...actions: WorkflowAction[]) => actions.reduce(workflowReducer, state);

let tokens = 0;
export async function load(state: WorkflowState, side: Side, csv: string): Promise<WorkflowState> {
  const token = `t${++tokens}`;
  const started = workflowReducer(state, { type: "import/started", side, token });
  return workflowReducer(started, await parseSource(side, token, `${side}.csv`, new TextEncoder().encode(csv)));
}

export function mapBoth(state: WorkflowState, mapping: DraftMapping = ID_NAME_QTY): WorkflowState {
  const fields = Object.entries(mapping) as [keyof DraftMapping, string | null][];
  return reduce(
    state,
    ...(["A", "B"] as const).flatMap((side) => fields.map(([field, columnId]): WorkflowAction => ({ type: "draft/fieldMapped", side, field, columnId }))),
    { type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: true },
  );
}

export async function confirm(state: WorkflowState): Promise<WorkflowState> {
  const r = await prepareConfirmation(state);
  if (!r.ok) throw new Error(`confirmation failed: ${JSON.stringify(r.errors)}`);
  return workflowReducer(state, r.action);
}

export async function loaded(a = SOURCE_A, b = SOURCE_B) {
  return mapBoth(await load(await load(initialWorkflowState, "A", a), "B", b));
}

export const confirmed = async (a = SOURCE_A, b = SOURCE_B) => confirm(await loaded(a, b));

export const rec = (s: WorkflowState): ReconciliationState => {
  if (!s.reconciliation) throw new Error("no reconciliation");
  return s.reconciliation;
};
export const rowA = (s: WorkflowState, i: number): RowId => rec(s).context.datasets.A.rows[i].id;
export const rowB = (s: WorkflowState, i: number): RowId => rec(s).context.datasets.B.rows[i].id;
export const runRef = (s: WorkflowState): RunRef => ({ generation: rec(s).generation, configurationHash: rec(s).context.configurationHash });

let ids = 0;
export function decide(s: WorkflowState, action: DecisionAction, leftId: RowId, rightId: RowId | null, extra: Partial<UserDecision> = {}): WorkflowAction {
  return {
    type: "decision/requested",
    decision: {
      id: `wd${++ids}`,
      action,
      leftId,
      rightId,
      proposalId: null,
      configurationHash: rec(s).context.configurationHash,
      at: "2026-10-15T00:00:00.000Z",
      ...extra,
    },
  };
}

// A suggestion citing the mapped name cell (c1) on both sides, as /api/suggest would.
export function suggestion(s: WorkflowState, leftId: RowId, rightId: RowId): IncomingProposal {
  const cell = (rowId: RowId) => rec(s).context.rows.get(rowId)!.name;
  return {
    leftId,
    rightId,
    outcome: "suggest",
    reasonCode: "semantic_equivalence",
    evidence: [
      { side: "A", rowId: leftId, columnId: "c1", value: cell(leftId) },
      { side: "B", rowId: rightId, columnId: "c1", value: cell(rightId) },
    ],
    explanation: "Same product.",
  };
}

export function batch(s: WorkflowState, requestId: string, proposals: IncomingProposal[], rowIds = proposals.map((p) => p.leftId)): WorkflowAction {
  return { type: "analysis/batchReceived", batch: { requestId, ...runRef(s), proposals }, rowIds };
}

export function expectInvariants(s: WorkflowState) {
  const report = checkInvariants(rec(s));
  expect(report.ok ? [] : report.violations).toEqual([]);
}
