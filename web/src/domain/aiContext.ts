// §7.4 AI context projection: the only view of source cells a model ever sees. Request
// building, proposal intake and audit replay all use it, so they cannot disagree.
import { cellOf, type ReconciliationContext } from "./eligibility";
import type { EvidenceRef, RowId } from "./types";

export const AI_CONTEXT_MAX_CODE_POINTS = 160;

// A prefix of at most 160 code points. Counting code points (not UTF-16 units) never splits a
// surrogate pair and matches Python's len() on the API. Grapheme clusters are not used because
// segmentation depends on the engine's Unicode data, which would make replay engine-dependent.
export function projectContext(cell: string): string {
  const points = Array.from(cell);
  return points.length <= AI_CONTEXT_MAX_CODE_POINTS ? cell : points.slice(0, AI_CONTEXT_MAX_CODE_POINTS).join("");
}

export const isTruncated = (cell: string) => projectContext(cell) !== cell;

// Identity evidence for one row: the mapped name, plus the product ID when mapped and nonblank.
// Never quantities, units or unmapped columns.
export function contextFields(ctx: ReconciliationContext, rowId: RowId): EvidenceRef[] {
  const info = ctx.rows.get(rowId);
  if (!info) return [];
  const dataset = ctx.datasets[info.side];
  const mapping = ctx.configuration[info.side];
  const fields: EvidenceRef[] = [];
  for (const columnId of [mapping.name, mapping.productId]) {
    if (columnId === null) continue;
    const cell = cellOf(dataset, info.row, columnId);
    if (cell.trim() !== "") fields.push({ side: info.side, rowId, columnId, value: projectContext(cell) });
  }
  return fields;
}

// True when hidden text could change what this row's identity fields say (fail closed).
export function identityContextTruncated(ctx: ReconciliationContext, rowId: RowId): boolean {
  const info = ctx.rows.get(rowId);
  if (!info) return false;
  const mapping = ctx.configuration[info.side];
  return [mapping.name, mapping.productId].some((c) => isTruncated(cellOf(ctx.datasets[info.side], info.row, c)));
}
