// Dispatch-boundary helpers: the async work (parsing, hashing) that must happen outside the
// reducer. Each returns an action; the reducer decides whether it is still current on arrival.
import { configurationHash, validateConfiguration, type MappingError } from "../domain/mapping";
import { parseDataset } from "../domain/parseCsv";
import type { Side } from "../domain/types";
import { loadedDatasets } from "./selectors";
import type { WorkflowAction, WorkflowState } from "./types";

export async function parseSource(side: Side, token: string, fileName: string, bytes: Uint8Array): Promise<WorkflowAction> {
  const r = await parseDataset(side, fileName, bytes);
  return r.ok ? { type: "import/succeeded", side, token, dataset: r.value } : { type: "import/failed", side, token, error: r.error };
}

export type Confirmation =
  | { ok: true; action: Extract<WorkflowAction, { type: "mapping/confirmed" }> }
  | { ok: false; errors: MappingError[] | null }; // null: a source is not loaded

export async function prepareConfirmation(state: WorkflowState): Promise<Confirmation> {
  const datasets = loadedDatasets(state);
  if (!datasets) return { ok: false, errors: null };
  const config = validateConfiguration(datasets, state.draft);
  if (!config.ok) return { ok: false, errors: config.error };
  const datasetIds = { A: datasets.A.id, B: datasets.B.id };
  const hash = await configurationHash(datasetIds, config.value);
  return { ok: true, action: { type: "mapping/confirmed", datasetIds, configuration: config.value, configurationHash: hash } };
}
