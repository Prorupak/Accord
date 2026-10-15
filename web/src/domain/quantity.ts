import { cellOf, type ReconciliationContext } from "./eligibility";
import { caseFold } from "./identity";
import type { Comparison, RowId } from "./types";

// §4.6: trimmed signed decimal, ≤12 integer digits, ≤3 fractional digits. No grouping,
// decimal commas, exponents, currency or unit suffixes.
const QUANTITY = /^(-?)(\d{1,12})(?:\.(\d{1,3}))?$/;

export type ParsedQuantity = { ok: true; thousandths: bigint } | { ok: false; reason: "missing" | "invalid" };

export function parseQuantity(raw: string): ParsedQuantity {
  const s = raw.trim();
  if (s === "") return { ok: false, reason: "missing" }; // blank is missing, never zero
  const m = QUANTITY.exec(s);
  if (!m) return { ok: false, reason: "invalid" };
  const magnitude = BigInt(m[2]) * 1000n + BigInt((m[3] ?? "").padEnd(3, "0"));
  return { ok: true, thousandths: m[1] === "-" ? -magnitude : magnitude }; // BigInt has no -0
}

// Canonical decimal string: no trailing fractional zeros, no bare point, never "-0".
export function formatThousandths(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${sign}${abs / 1000n}${frac ? `.${frac}` : ""}`;
}

type UnitCheck = "ok" | "unit_mismatch" | "unit_unknown";

function unitCheck(ctx: ReconciliationContext, leftId: RowId, rightId: RowId): UnitCheck {
  const { A, B } = ctx.configuration;
  if (A.unit === null && B.unit === null) return ctx.configuration.sharedQuantityUnitConfirmed ? "ok" : "unit_unknown";
  if (A.unit === null || B.unit === null) return "unit_unknown"; // one side has units, the other lacks them
  const unit = (id: RowId, column: string, side: "A" | "B") =>
    caseFold(cellOf(ctx.datasets[side], ctx.rows.get(id)!.row, column).trim());
  const ua = unit(leftId, A.unit, "A");
  const ub = unit(rightId, B.unit, "B");
  if (ua === "" || ub === "") return "unit_unknown"; // missing units never imply equivalence
  return ua === ub ? "ok" : "unit_mismatch"; // no conversion: "kg" vs "kilogram" is a mismatch
}

// Recomputed from immutable source cells every time; delta is Source B minus Source A.
export function compareQuantities(ctx: ReconciliationContext, leftId: RowId, rightId: RowId): Comparison {
  const left = ctx.rows.get(leftId)!;
  const right = ctx.rows.get(rightId)!;
  const leftRaw = cellOf(ctx.datasets.A, left.row, ctx.configuration.A.quantity);
  const rightRaw = cellOf(ctx.datasets.B, right.row, ctx.configuration.B.quantity);
  const a = parseQuantity(leftRaw);
  const b = parseQuantity(rightRaw);
  if (!a.ok || !b.ok) return { status: "invalid", leftRaw, rightRaw, delta: null };
  const units = unitCheck(ctx, leftId, rightId);
  if (units !== "ok") return { status: units, leftRaw, rightRaw, delta: null };
  const delta = b.thousandths - a.thousandths;
  return { status: delta === 0n ? "equal" : "different", leftRaw, rightRaw, delta: formatThousandths(delta) };
}
