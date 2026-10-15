// Pure /api/suggest request construction from current reconciliation state (spec §4.4, §7.4).
import { contextFields } from "../domain/aiContext";
import { candidatesFor } from "../domain/candidates";
import type { ReconciliationState } from "../domain/reconcile";
import type { RowId } from "../domain/types";
import { failure, SUGGEST_LIMITS, suggestRequestSchema, type AnalysisFailure, type SuggestRequest } from "./contract";

// The exact bytes that will be sent, and the parsed request they encode. The response is
// validated against this frozen request, never against later state.
export type BuiltRequest = { readonly request: SuggestRequest; readonly body: string; readonly bytes: number };

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

// Rows without retrievable candidates are the caller's to skip; passing one is a programming
// error reported as INVALID_REQUEST rather than a request with an empty candidate list.
export function buildSuggestRequest(
  rec: ReconciliationState,
  rowIds: readonly RowId[],
  requestId: string,
  maxBytes: number = SUGGEST_LIMITS.maxBodyBytes,
): { ok: true; value: BuiltRequest } | { ok: false; error: AnalysisFailure } {
  const ctx = rec.context;
  const invalid = () => ({ ok: false as const, error: failure("INVALID_REQUEST", requestId, rowIds) });
  if (rowIds.length === 0 || rowIds.length > SUGGEST_LIMITS.maxSuggestRows) return invalid();

  const rows = rowIds.map((leftId) => ({
    left: { rowId: leftId, fields: contextFields(ctx, leftId) },
    candidates: candidatesFor(rec, leftId).map(({ rightId }) => ({ rowId: rightId, fields: contextFields(ctx, rightId) })),
  }));
  const request = { requestId, generation: rec.generation, configurationHash: ctx.configurationHash, rows };
  if (!suggestRequestSchema.safeParse(request).success) return invalid();

  const body = JSON.stringify(request);
  const bytes = utf8Bytes(body);
  if (bytes > maxBytes) return { ok: false, error: failure("PAYLOAD_TOO_LARGE", requestId, rowIds) };
  return { ok: true, value: Object.freeze({ request: deepFreeze(request), body, bytes }) };
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
}
