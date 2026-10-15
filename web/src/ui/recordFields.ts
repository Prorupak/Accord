import { cellOf } from "../domain/eligibility";
import type { ReconciliationState } from "../domain/reconcile";
import type { RowId } from "../domain/types";

// A record's mapped canonical values, read from its original cells under the confirmed mapping.
export function recordFields(rec: ReconciliationState, rowId: RowId) {
  const info = rec.context.rows.get(rowId)!;
  const dataset = rec.context.datasets[info.side];
  const m = rec.context.configuration[info.side];
  const cell = (c: string | null) => cellOf(dataset, info.row, c);
  return { side: info.side, row: info.row, dataset, productId: cell(m.productId), name: cell(m.name), quantity: cell(m.quantity), unit: cell(m.unit) };
}

export function describe(rec: ReconciliationState, rowId: RowId): string {
  const f = recordFields(rec, rowId);
  const name = f.name.trim() === "" ? "(no name)" : f.name;
  return f.productId.trim() === "" ? name : `${name} [${f.productId}]`;
}
