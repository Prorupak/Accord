// Test-only helpers: build reconciliation state from CSV text through the real pipeline.
import { buildContext } from "./eligibility";
import { configurationHash, validateConfiguration, type DraftConfiguration, type DraftMapping } from "./mapping";
import { parseDataset } from "./parseCsv";
import { initializeState, type ReconciliationState } from "./reconcile";
import type { Dataset, DecisionAction, RowId, Side, UserDecision } from "./types";

export const ID_NAME_QTY: DraftMapping = { productId: "c0", name: "c1", quantity: "c2", unit: null };

export async function dataset(side: Side, csv: string | Uint8Array): Promise<Dataset> {
  const bytes = typeof csv === "string" ? new TextEncoder().encode(csv) : csv;
  const r = await parseDataset(side, `${side}.csv`, bytes);
  if (!r.ok) throw new Error(`fixture failed to parse: ${r.error.code}`);
  return r.value;
}

export async function setup(
  aCsv: string | Uint8Array,
  bCsv: string | Uint8Array,
  overrides: Partial<DraftConfiguration> = {},
): Promise<ReconciliationState> {
  const datasets = { A: await dataset("A", aCsv), B: await dataset("B", bCsv) };
  const draft: DraftConfiguration = {
    A: ID_NAME_QTY,
    B: ID_NAME_QTY,
    idCaseSensitive: true,
    sharedQuantityUnitConfirmed: true,
    ...overrides,
  };
  const config = validateConfiguration(datasets, draft);
  if (!config.ok) throw new Error(`fixture mapping invalid: ${JSON.stringify(config.error)}`);
  const hash = await configurationHash({ A: datasets.A.id, B: datasets.B.id }, config.value);
  return initializeState(buildContext(datasets, config.value, hash));
}

export const rowA = (s: ReconciliationState, index: number): RowId => s.context.datasets.A.rows[index].id;
export const rowB = (s: ReconciliationState, index: number): RowId => s.context.datasets.B.rows[index].id;

let seq = 0;
export function decision(
  s: ReconciliationState,
  action: DecisionAction,
  leftId: RowId,
  rightId: RowId | null,
  extra: Partial<UserDecision> = {},
): UserDecision {
  return {
    id: `d${++seq}`,
    action,
    leftId,
    rightId,
    proposalId: null,
    configurationHash: s.context.configurationHash,
    at: "2026-10-15T00:00:00.000Z",
    ...extra,
  };
}
