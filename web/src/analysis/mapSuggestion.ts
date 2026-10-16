// Optional AI column-mapping drafts from POST /api/map (spec §7.2, §8). Mirrors MapRequest and
// MapResponse in api/app/schemas.py. A result is only ever a draft the user may apply; nothing
// here touches workflow state, and nothing is retried.
import { z } from "zod";
import type { CanonicalField, DraftMapping } from "../domain/mapping";
import type { Dataset, Side } from "../domain/types";
import { apiUrl } from "./availability";
import { failure, inferenceMetaSchema, type AnalysisFailure, type InferenceMeta } from "./contract";
import { debugLog } from "./debug";
import { readApiError } from "./response";
import type { Transport } from "./runner";

export const MAX_MAP_SAMPLES = 5;

export type MapRequest = {
  requestId: string;
  generation: number;
  datasets: Array<{
    side: Side;
    datasetId: string;
    columns: Array<{ id: string; header: string }>;
    samples: Array<{ rowId: string; cells: string[] }>;
  }>;
};

// Headers and the first five records per side; never the whole dataset.
export function buildMapRequest(datasets: { A: Dataset; B: Dataset }, requestId: string, generation: number): MapRequest {
  return {
    requestId,
    generation,
    datasets: [datasets.A, datasets.B].map((d) => ({
      side: d.side,
      datasetId: d.id,
      columns: d.columns.map((c) => ({ id: c.id, header: c.header })),
      samples: d.rows.slice(0, MAX_MAP_SAMPLES).map((r) => ({ rowId: r.id, cells: [...r.cells] })),
    })),
  };
}

const column = z.string().nullable();
const sideDraft = z.strictObject({
  mapping: z.strictObject({ productId: column, name: column, quantity: column, unit: column }),
  explanations: z.strictObject({ productId: z.string(), name: z.string(), quantity: z.string(), unit: z.string() }),
});

export const mapResponseSchema = z.strictObject({
  requestId: z.string(),
  generation: z.number().int(),
  A: sideDraft,
  B: sideDraft,
  warnings: z.array(z.string()),
  meta: inferenceMetaSchema,
});

export type MapSuggestion = {
  readonly draft: { readonly A: DraftMapping; readonly B: DraftMapping };
  readonly explanations: { readonly A: Record<CanonicalField, string>; readonly B: Record<CanonicalField, string> };
  readonly warnings: readonly string[];
  readonly meta: InferenceMeta;
};

export type MapResult = { ok: true; value: MapSuggestion } | { ok: false; error: AnalysisFailure };

export const fetchMapTransport: Transport = async (body, signal) => {
  const startedAt = performance.now();
  const res = await fetch(apiUrl("/api/map"), { method: "POST", headers: { "content-type": "application/json" }, body, signal });
  const text = await res.text();
  debugLog("map response", res.status, `${Math.round(performance.now() - startedAt)}ms`, text);
  return { status: res.status, body: text };
};

export async function requestMapSuggestion(
  datasets: { A: Dataset; B: Dataset },
  opts: { requestId: string; generation: number; signal: AbortSignal; transport?: Transport },
): Promise<MapResult> {
  const request = buildMapRequest(datasets, opts.requestId, opts.generation);
  const fail = (code: Parameters<typeof failure>[0], reason: unknown): MapResult => {
    debugLog("map rejected", opts.requestId, code, reason);
    return { ok: false, error: failure(code, opts.requestId, []) };
  };
  let http;
  try {
    http = await (opts.transport ?? fetchMapTransport)(JSON.stringify(request), opts.signal);
  } catch {
    return fail(opts.signal.aborted ? "CANCELLED" : "NETWORK", "transport threw");
  }
  let json: unknown;
  try {
    json = JSON.parse(http.body);
  } catch {
    return fail("MALFORMED_RESPONSE", "body is not JSON");
  }
  if (http.status !== 200) {
    const error = readApiError(http.status, json, opts.requestId, []);
    debugLog("map error", opts.requestId, http.status, error.code, json);
    return { ok: false, error };
  }

  const parsed = mapResponseSchema.safeParse(json);
  if (!parsed.success || parsed.data.requestId !== request.requestId || parsed.data.generation !== request.generation)
    return fail("CONTRACT_MISMATCH", parsed.success ? "requestId/generation echo differs" : parsed.error.issues);
  const res = parsed.data;
  // The server verifies this too; the browser does not trust it blindly.
  for (const side of ["A", "B"] as const) {
    const known = new Set(datasets[side].columns.map((c) => c.id));
    const chosen = Object.values(res[side].mapping).filter((v): v is string => v !== null);
    if (chosen.some((id) => !known.has(id)) || new Set(chosen).size !== chosen.length) return fail("MODEL_INVALID_OUTPUT", `side ${side}: unknown or duplicate column`);
  }
  return {
    ok: true,
    value: {
      draft: { A: res.A.mapping, B: res.B.mapping },
      explanations: { A: res.A.explanations, B: res.B.explanations },
      warnings: res.warnings,
      meta: res.meta,
    },
  };
}
