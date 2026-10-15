import { checkPair } from "./eligibility";
import { decisionPairId, exactPairId, partition, type ReconciliationState } from "./reconcile";

export type InvariantCode =
  | "stale_pair"
  | "ineligible_pair"
  | "duplicate_pair_id"
  | "row_reused"
  | "missing_decision"
  | "invalid_exact_pair"
  | "unknown_ledger_row"
  | "conservation";

export type Violation = { code: InvariantCode; message: string; pairId?: string; rowId?: string };

export type InvariantReport =
  | { ok: true; counts: { leftCount: number; rightCount: number; pairCount: number } }
  | { ok: false; violations: Violation[] };

// §4.7 export invariants, evaluated from authoritative state only (no cached counters).
// Each pair is re-checked against the single eligibility policy with the other pairs as context.
export function checkInvariants(state: ReconciliationState): InvariantReport {
  const ctx = state.context;
  const violations: Violation[] = [];
  const v = (code: InvariantCode, message: string, at: Partial<Violation> = {}) => violations.push({ code, message, ...at });

  const pairIds = new Set<string>();
  const usedRows = new Set<string>();
  for (const pair of state.acceptedPairs) {
    const at = { pairId: pair.id };
    if (pair.configurationHash !== ctx.configurationHash) v("stale_pair", "Pair belongs to another configuration.", at);
    if (pairIds.has(pair.id)) v("duplicate_pair_id", "Pair ID is repeated.", at);
    pairIds.add(pair.id);
    for (const rowId of [pair.leftId, pair.rightId]) {
      if (usedRows.has(rowId)) v("row_reused", "A record appears in more than one accepted pair.", { ...at, rowId });
      usedRows.add(rowId);
    }

    const others = { ...state, acceptedPairs: state.acceptedPairs.filter((p) => p !== pair) };
    const method = pair.method === "exact_id" ? "exact_id" : "semantic";
    const e = checkPair(ctx, others, pair.leftId, pair.rightId, method);
    // Row reuse is reported above; here we want identity, exclusion and rejection failures.
    if (!e.ok && e.reason !== "unavailable") v("ineligible_pair", `Pair violates policy: ${e.reason}.`, at);

    if (pair.method === "exact_id") {
      if (pair.decisionId !== null || pair.proposalId !== null || pair.id !== exactPairId(pair.leftId, pair.rightId))
        v("invalid_exact_pair", "Automatic pair has decision data or a non-canonical ID.", at);
      continue;
    }

    // Semantic/manual pairs need an explicit, still-effective human acceptance.
    const index = state.decisions.findIndex((d) => d.id === pair.decisionId);
    const d = state.decisions[index];
    const proposal = pair.proposalId === null ? null : state.proposals.find((p) => p.id === pair.proposalId);
    const undone = state.decisions
      .slice(index + 1)
      .some((x) => x.action === "undo" && x.leftId === pair.leftId && x.rightId === pair.rightId);
    const valid =
      d !== undefined &&
      d.action === "accept" &&
      d.leftId === pair.leftId &&
      d.rightId === pair.rightId &&
      d.configurationHash === ctx.configurationHash &&
      d.proposalId === pair.proposalId &&
      pair.id === decisionPairId(d.id) &&
      !undone &&
      (pair.method === "manual"
        ? pair.proposalId === null
        : proposal !== undefined && proposal !== null && proposal.outcome === "suggest" && proposal.leftId === pair.leftId && proposal.rightId === pair.rightId);
    if (!valid) v("missing_decision", "Semantic or manual pair lacks a matching explicit user decision.", at);
  }

  for (const p of [...state.rejectedPairs, ...state.excludedExactPairs])
    if (!ctx.rows.has(p.leftId) || !ctx.rows.has(p.rightId))
      v("unknown_ledger_row", "A rejection or exclusion references a nonexistent record.");

  const { A, B } = ctx.datasets;
  const { pairs, unmatchedA, unmatchedB } = partition(state);
  for (const [dataset, unmatched] of [[A, unmatchedA], [B, unmatchedB]] as const) {
    const seen = [...pairs.map((p) => (dataset.side === "A" ? p.leftId : p.rightId)), ...unmatched];
    const exactlyOnce = seen.length === new Set(seen).size && dataset.rows.every((r) => seen.includes(r.id));
    if (dataset.rows.length !== pairs.length + unmatched.length || !exactlyOnce)
      v("conservation", `Source ${dataset.side} rows do not equal accepted pairs plus unmatched rows.`);
  }

  return violations.length > 0
    ? { ok: false, violations }
    : { ok: true, counts: { leftCount: A.rows.length, rightCount: B.rows.length, pairCount: pairs.length } };
}
