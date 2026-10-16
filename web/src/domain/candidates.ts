import { checkIdentity, checkPair, pairedRows } from "./eligibility";
import { caseFold } from "./identity";
import type { ReconciliationState } from "./reconcile";
import { LIMITS, type RowId } from "./types";

// §4.4: NFKC, case fold, punctuation and symbols to spaces, collapse whitespace.
export function normalizeName(s: string): string {
  return caseFold(s.normalize("NFKC"))
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

export function nameTokens(s: string): ReadonlySet<string> {
  const n = normalizeName(s);
  return new Set(n === "" ? [] : n.split(" "));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export type Candidate = { readonly rightId: RowId; readonly score: number };

// Lexical retrieval only: quantities never affect the score, and there is no synonym table.
// Top five positive-score, policy-eligible Source B rows; ties broken by Source B record index.
// Candidates reserve nothing; acceptance enforces availability.
export function candidatesFor(state: ReconciliationState, leftId: RowId): Candidate[] {
  const ctx = state.context;
  const left = ctx.rows.get(leftId);
  if (!left || left.side !== "A") return [];
  const leftTokens = nameTokens(left.name);
  const scored: Array<Candidate & { index: number }> = [];
  for (const row of ctx.datasets.B.rows) {
    if (!checkPair(ctx, state, leftId, row.id, "semantic").ok) continue;
    const score = jaccard(leftTokens, nameTokens(ctx.rows.get(row.id)!.name));
    if (score > 0) scored.push({ rightId: row.id, score, index: row.index });
  }
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  return scored.slice(0, LIMITS.maxCandidates).map(({ rightId, score }) => ({ rightId, score }));
}

// The manual picker: every eligible Source B row, including zero-overlap ones, in source order.
export function eligibleRightRows(state: ReconciliationState, leftId: RowId): RowId[] {
  return state.context.datasets.B.rows
    .filter((row) => checkPair(state.context, state, leftId, row.id, "semantic").ok)
    .map((row) => row.id);
}

// True when an unpaired Source B row shares name tokens with this row but is ruled out only
// because the two product IDs differ. Explains `conflicting_id` for rows with no candidates.
export function blockedByIdConflict(state: ReconciliationState, leftId: RowId): boolean {
  const ctx = state.context;
  const left = ctx.rows.get(leftId);
  if (!left) return false;
  const leftTokens = nameTokens(left.name);
  const used = pairedRows(state.acceptedPairs);
  return ctx.datasets.B.rows.some((row) => {
    if (used.has(row.id)) return false;
    const identity = checkIdentity(ctx, leftId, row.id, "semantic");
    return !identity.ok && identity.reason === "conflicting_id" && jaccard(leftTokens, nameTokens(ctx.rows.get(row.id)!.name)) > 0;
  });
}
