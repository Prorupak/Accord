import { normalizeId } from "./identity";
import type { ColumnId, Configuration, Dataset, Pair, Row, RowId, RowPair, Side } from "./types";

export type RowInfo = {
  readonly side: Side;
  readonly row: Row;
  readonly normalizedId: string; // "" when unmapped or blank
  readonly name: string; // raw mapped name cell
};

// Immutable facts derived once per confirmed configuration.
export type ReconciliationContext = {
  readonly datasets: { readonly A: Dataset; readonly B: Dataset };
  readonly configuration: Configuration;
  readonly configurationHash: string;
  readonly rows: ReadonlyMap<RowId, RowInfo>;
  readonly quarantined: ReadonlySet<RowId>;
};

// The parts of reconciliation state that availability depends on.
export type PairLedger = {
  readonly acceptedPairs: readonly Pair[];
  readonly rejectedPairs: readonly RowPair[];
  readonly excludedExactPairs: readonly RowPair[];
};

export function cellOf(dataset: Dataset, row: Row, columnId: ColumnId | null): string {
  if (columnId === null) return "";
  const column = dataset.columns.find((c) => c.id === columnId);
  return column ? row.cells[column.index] : "";
}

export function buildContext(
  datasets: { A: Dataset; B: Dataset },
  configuration: Configuration,
  configurationHash: string,
): ReconciliationContext {
  const rows = new Map<RowId, RowInfo>();
  // Normalized ID → row IDs carrying it, per side.
  const carriers: Record<Side, Map<string, RowId[]>> = { A: new Map(), B: new Map() };
  for (const side of ["A", "B"] as const) {
    const dataset = datasets[side];
    const mapping = configuration[side];
    for (const row of dataset.rows) {
      const normalizedId = normalizeId(cellOf(dataset, row, mapping.productId), configuration.idCaseSensitive);
      rows.set(row.id, { side, row, normalizedId, name: cellOf(dataset, row, mapping.name) });
      if (normalizedId !== "") carriers[side].set(normalizedId, [...(carriers[side].get(normalizedId) ?? []), row.id]);
    }
  }
  // §4.3: an ID repeated in either source quarantines every row carrying it on both sides,
  // including an otherwise unique occurrence on the opposite side.
  const quarantined = new Set<RowId>();
  for (const side of ["A", "B"] as const) {
    for (const [id, ids] of carriers[side]) {
      if (ids.length < 2) continue;
      for (const s of ["A", "B"] as const) for (const rowId of carriers[s].get(id) ?? []) quarantined.add(rowId);
    }
  }
  return { datasets, configuration, configurationHash, rows, quarantined };
}

export type EligibilityFailure =
  | "unknown_row"
  | "wrong_side"
  | "duplicate_id"
  | "conflicting_id"
  | "not_exact_id"
  | "missing_name"
  | "excluded_exact_pair"
  | "rejected_pair"
  | "unavailable";

export const ELIGIBILITY_MESSAGES: Record<EligibilityFailure, string> = {
  unknown_row: "One of these records does not exist in the current datasets.",
  wrong_side: "A pair needs one Source A record and one Source B record.",
  duplicate_id: "A product ID on one of these records appears more than once. Fix the source or mapping first.",
  conflicting_id: "These records have different product IDs and cannot be paired.",
  not_exact_id: "These records do not share a unique product ID.",
  missing_name: "A record without a product name can only be paired by product ID.",
  excluded_exact_pair: "This ID match was excluded. Undo the exclusion to restore it.",
  rejected_pair: "This pair was rejected. Undo the rejection to reconsider it.",
  unavailable: "One of these records is already in an accepted pair.",
};

export type Eligibility = { ok: true } | { ok: false; reason: EligibilityFailure; message: string };

const keyOf = (p: RowPair) => `${p.leftId}\u0000${p.rightId}`;

// Lookup sets cached per immutable array; state transitions always replace arrays.
const pairKeyCache = new WeakMap<readonly RowPair[], Set<string>>();
const usedRowCache = new WeakMap<readonly Pair[], Set<RowId>>();

export function hasPair(list: readonly RowPair[], leftId: RowId, rightId: RowId): boolean {
  let keys = pairKeyCache.get(list);
  if (!keys) pairKeyCache.set(list, (keys = new Set(list.map(keyOf))));
  return keys.has(keyOf({ leftId, rightId }));
}

export function pairedRows(pairs: readonly Pair[]): ReadonlySet<RowId> {
  let used = usedRowCache.get(pairs);
  if (!used) usedRowCache.set(pairs, (used = new Set(pairs.flatMap((p) => [p.leftId, p.rightId]))));
  return used;
}

// Identity policy only: what the sources and configuration allow, independent of decisions.
export function checkIdentity(
  ctx: ReconciliationContext,
  leftId: RowId,
  rightId: RowId,
  method: "exact_id" | "semantic",
): Eligibility {
  const left = ctx.rows.get(leftId);
  const right = ctx.rows.get(rightId);
  const no = (reason: EligibilityFailure): Eligibility => ({ ok: false, reason, message: ELIGIBILITY_MESSAGES[reason] });
  if (!left || !right) return no("unknown_row");
  if (left.side !== "A" || right.side !== "B") return no("wrong_side");
  if (ctx.quarantined.has(leftId) || ctx.quarantined.has(rightId)) return no("duplicate_id");
  const bothIds = left.normalizedId !== "" && right.normalizedId !== "";
  if (bothIds && left.normalizedId !== right.normalizedId) return no("conflicting_id");
  if (method === "exact_id" && !bothIds) return no("not_exact_id");
  if (method === "semantic" && (left.name.trim() === "" || right.name.trim() === "")) return no("missing_name");
  return { ok: true };
}

// The single eligibility policy. Exact matching, candidate retrieval, proposal intake,
// decisions, invariants and audit replay all call this, so they cannot disagree.
export function checkPair(
  ctx: ReconciliationContext,
  ledger: PairLedger,
  leftId: RowId,
  rightId: RowId,
  method: "exact_id" | "semantic",
): Eligibility {
  const identity = checkIdentity(ctx, leftId, rightId, method);
  if (!identity.ok) return identity;
  const no = (reason: EligibilityFailure): Eligibility => ({ ok: false, reason, message: ELIGIBILITY_MESSAGES[reason] });
  if (hasPair(ledger.excludedExactPairs, leftId, rightId)) return no("excluded_exact_pair");
  if (hasPair(ledger.rejectedPairs, leftId, rightId)) return no("rejected_pair");
  const used = pairedRows(ledger.acceptedPairs);
  if (used.has(leftId) || used.has(rightId)) return no("unavailable");
  return { ok: true };
}
