// Validation of one /api/suggest HTTP response against the frozen request that produced it
// (spec §7.4, §8). This never repairs model output and never touches decisions: a valid result
// becomes a ProposalBatch that the workflow reducer and domain intake check again.
import type { IncomingProposal, ProposalBatch } from "../domain/reconcile";
import {
  apiErrorSchema,
  failure,
  suggestResponseSchema,
  type AnalysisFailure,
  type ApiErrorCode,
  type FailureCode,
  type InferenceMeta,
  type SuggestRequest,
} from "./contract";
import { debugLog } from "./debug";

export type HttpResult = { readonly status: number; readonly body: string };

export type ReadResult =
  | { ok: true; batch: ProposalBatch; meta: InferenceMeta }
  // `meta` is present when the server reported a well-formed response whose content failed.
  | { ok: false; error: AnalysisFailure; meta: InferenceMeta | null };

// §8.3 status for each server code; any other pairing is a contract mismatch.
const ERROR_STATUS: Record<ApiErrorCode, { statuses: readonly number[]; code: FailureCode }> = {
  INVALID_INPUT: { statuses: [400, 403, 415], code: "INVALID_REQUEST" },
  PAYLOAD_TOO_LARGE: { statuses: [413], code: "PAYLOAD_TOO_LARGE" },
  BUSY: { statuses: [409], code: "BUSY" },
  NOT_CONFIGURED: { statuses: [503], code: "NOT_CONFIGURED" },
  RATE_LIMITED: { statuses: [429], code: "RATE_LIMITED" },
  MODEL_INVALID_OUTPUT: { statuses: [502], code: "MODEL_INVALID_OUTPUT" },
  UPSTREAM_ERROR: { statuses: [500, 502], code: "UPSTREAM_ERROR" },
  TIMEOUT: { statuses: [504], code: "SERVER_TIMEOUT" },
};

// A non-200 §8.3 envelope as a typed failure; shared by the suggest and map clients.
export function readApiError(status: number, json: unknown, requestId: string, rowIds: readonly string[]): AnalysisFailure {
  const env = apiErrorSchema.safeParse(json);
  if (!env.success) return failure("CONTRACT_MISMATCH", requestId, rowIds);
  const e = env.data.error;
  const known = ERROR_STATUS[e.code];
  // The server echoes "" when it rejected the body before reading a request ID.
  if (!known.statuses.includes(status) || (e.requestId !== "" && e.requestId !== requestId)) return failure("CONTRACT_MISMATCH", requestId, rowIds);
  return failure(known.code, requestId, rowIds, { retryable: e.retryable, retryAfterSeconds: e.retryAfterSeconds });
}

const key = (side: string, rowId: string, columnId: string) => `${side}\u0000${rowId}\u0000${columnId}`;

export function readSuggestResponse(request: SuggestRequest, http: HttpResult): ReadResult {
  const rowIds = request.rows.map((r) => r.left.rowId);
  const fail = (code: FailureCode, reason: unknown, meta: InferenceMeta | null = null): ReadResult => {
    debugLog("suggest rejected", request.requestId, code, reason);
    return { ok: false, error: failure(code, request.requestId, rowIds), meta };
  };

  let json: unknown;
  try {
    json = JSON.parse(http.body);
  } catch {
    return fail("MALFORMED_RESPONSE", "body is not JSON");
  }

  if (http.status !== 200) {
    const error = readApiError(http.status, json, request.requestId, rowIds);
    debugLog("suggest error", request.requestId, http.status, error.code, json);
    return { ok: false, error, meta: null };
  }

  const parsed = suggestResponseSchema.safeParse(json);
  if (!parsed.success) return fail("CONTRACT_MISMATCH", parsed.error.issues);
  const res = parsed.data;
  const echoes = (x: { generation: number; configurationHash: string }) =>
    x.generation === request.generation && x.configurationHash === request.configurationHash;
  if (res.requestId !== request.requestId || !echoes(res) || !res.proposals.every(echoes)) return fail("CONTRACT_MISMATCH", "requestId/generation/configurationHash echo differs");

  // From here the envelope is trustworthy and only the model's content can be wrong.
  const invalid = (reason: string) => fail("MODEL_INVALID_OUTPUT", reason, res.meta);
  const byLeft = new Map(res.proposals.map((p) => [p.leftId, p]));
  if (byLeft.size !== res.proposals.length || byLeft.size !== rowIds.length || !rowIds.every((id) => byLeft.has(id))) return invalid("proposals do not cover exactly the requested rows");

  const proposals: IncomingProposal[] = [];
  for (const row of request.rows) {
    const p = byLeft.get(row.left.rowId)!;
    const candidateIds = row.candidates.map((c) => c.rowId);
    if (p.outcome === "suggest") {
      if (p.reasonCode !== "semantic_equivalence" || p.rightId === null || !candidateIds.includes(p.rightId)) return invalid(`${p.leftId}: suggestion needs semantic_equivalence and a supplied candidate`);
    } else if (p.rightId !== null || p.reasonCode === "semantic_equivalence") return invalid(`${p.leftId}: abstention has a candidate or suggest reason`);

    // Evidence must be a field this request supplied for this row, with the exact supplied
    // value. A suggestion may cite only its own two rows and must cite both.
    const owners = p.outcome === "suggest" ? [row.left, row.candidates.find((c) => c.rowId === p.rightId)!] : [row.left, ...row.candidates];
    const supplied = new Map(owners.flatMap((o) => o.fields.map((f) => [key(f.side, f.rowId, f.columnId), f.value] as const)));
    const bad = p.evidence.find((ev) => supplied.get(key(ev.side, ev.rowId, ev.columnId)) !== ev.value);
    if (bad) return invalid(`${p.leftId}: evidence ${bad.side}/${bad.rowId}/${bad.columnId} was not supplied with that value`);
    if (p.outcome === "suggest" && !(p.evidence.some((ev) => ev.side === "A") && p.evidence.some((ev) => ev.side === "B")))
      return invalid(`${p.leftId}: suggestion needs evidence from both rows`);

    proposals.push({
      leftId: p.leftId,
      rightId: p.rightId,
      outcome: p.outcome,
      reasonCode: p.reasonCode,
      evidence: p.evidence.map((ev) => ({ side: ev.side, rowId: ev.rowId, columnId: ev.columnId, value: ev.value })),
      explanation: p.explanation,
    });
  }
  return {
    ok: true,
    batch: { requestId: request.requestId, generation: request.generation, configurationHash: request.configurationHash, proposals },
    meta: res.meta,
  };
}
