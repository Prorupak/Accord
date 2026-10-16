// The review table's rows, derived from reconciliation state on every render and never stored.
// One row per Source A record in record order, then each unmatched Source B record.
import { compareQuantities } from "../domain/quantity";
import { partition, pendingProposals, unresolvedReason, type ReconciliationState, type Unresolved } from "../domain/reconcile";
import type { Comparison, Pair, Proposal, RowId, Side } from "../domain/types";

export type ReviewRow =
  | { kind: "pair"; key: RowId; pair: Pair; comparison: Comparison }
  | { kind: "pending"; key: RowId; proposal: Proposal & { rightId: RowId }; comparison: Comparison }
  | { kind: "unresolved"; key: RowId; side: Side; unresolved: Unresolved };

export type ReviewFilter = "all" | "needs_review" | "matched" | "unresolved" | "conflicts";

export const FILTERS: ReadonlyArray<{ id: ReviewFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs_review", label: "Needs review" },
  { id: "matched", label: "Matched" },
  { id: "unresolved", label: "Unresolved" },
  { id: "conflicts", label: "Identifier conflicts" },
];

export function reviewRows(rec: ReconciliationState): ReviewRow[] {
  const { pairs, unmatchedB } = partition(rec);
  const pairByLeft = new Map(pairs.map((p) => [p.leftId, p]));
  // The latest pending proposal per Source A row.
  const pending = new Map<RowId, Proposal & { rightId: RowId }>();
  for (const p of pendingProposals(rec)) if (p.rightId !== null) pending.set(p.leftId, p as Proposal & { rightId: RowId });

  const rows: ReviewRow[] = rec.context.datasets.A.rows.map((row): ReviewRow => {
    const pair = pairByLeft.get(row.id);
    if (pair) return { kind: "pair", key: row.id, pair, comparison: compareQuantities(rec.context, pair.leftId, pair.rightId) };
    const proposal = pending.get(row.id);
    if (proposal) return { kind: "pending", key: row.id, proposal, comparison: compareQuantities(rec.context, row.id, proposal.rightId) };
    return { kind: "unresolved", key: row.id, side: "A", unresolved: unresolvedReason(rec, row.id) };
  });
  for (const id of unmatchedB) rows.push({ kind: "unresolved", key: id, side: "B", unresolved: unresolvedReason(rec, id) });
  return rows;
}

const isConflict = (row: ReviewRow) =>
  row.kind === "unresolved" && (row.unresolved.reason === "duplicate_id" || row.unresolved.reason === "conflicting_id");

export function matchesFilter(row: ReviewRow, filter: ReviewFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs_review":
      return row.kind === "pending";
    case "matched":
      return row.kind === "pair";
    case "unresolved":
      return row.kind === "unresolved";
    case "conflicts":
      return isConflict(row);
  }
}

const METHOD_LABEL = { exact_id: "Matched by product ID", ai_reviewed: "Approved suggestion", manual: "Manual match" } as const;

const REASON_LABEL: Record<Unresolved["reason"], string> = {
  duplicate_id: "Identifier conflict: duplicate ID",
  conflicting_id: "Identifier conflict",
  missing_name: "Unresolved: no name",
  no_candidates: "Unresolved: no candidates",
  ambiguous: "Unresolved: ambiguous",
  rejected: "Unresolved: rejected",
  deferred: "Unresolved: left by you",
  analysis_limit: "Unresolved: outside AI limit",
  analysis_failed: "Unresolved: analysis failed",
  analysis_cancelled: "Unresolved: analysis cancelled",
  unpaired: "Unresolved",
};

export function statusLabel(row: ReviewRow): string {
  if (row.kind === "pair") return METHOD_LABEL[row.pair.method];
  if (row.kind === "pending") return "Suggested pair: needs your review";
  return REASON_LABEL[row.unresolved.reason];
}

export const COMPARISON_LABEL: Record<Comparison["status"], string> = {
  equal: "Quantities equal",
  different: "Quantity differs",
  invalid: "Not a supported decimal; original preserved",
  unit_mismatch: "Units differ; no difference calculated",
  unit_unknown: "Confirm comparable units before calculating a difference",
};
