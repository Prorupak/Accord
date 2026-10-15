// The /api/suggest wire contract, mirrored exactly from api/app/schemas.py (spec §8). Shared
// fixtures in fixtures/contracts/suggest are checked by both this file's tests and pytest, so a
// change on either side fails a test instead of drifting.
import { z } from "zod";
import { LIMITS } from "../domain/types";

export const SUGGEST_LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxIdChars: 128,
  maxCellChars: 2048,
  maxSuggestRows: 5,
  maxCandidates: LIMITS.maxCandidates,
  maxEvidence: 6,
  maxExplanationChars: 240,
  maxRequestsPerPass: 4,
  maxRowsPerPass: LIMITS.maxAnalysisRows,
  runDeadlineMs: 240_000,
} as const;

// Python's len() counts code points; Zod's .max() counts UTF-16 units.
const codePoints = (max: number) => (s: string) => Array.from(s).length <= max;
const id = z.string().min(1).refine(codePoints(SUGGEST_LIMITS.maxIdChars), "too long");
const side = z.enum(["A", "B"]);

export const evidenceRefSchema = z.strictObject({
  side,
  rowId: z.string().refine(codePoints(SUGGEST_LIMITS.maxIdChars), "too long"),
  columnId: z.string().refine(codePoints(SUGGEST_LIMITS.maxIdChars), "too long"),
  value: z.string().refine(codePoints(SUGGEST_LIMITS.maxCellChars), "too long"),
});

const rowFields = z.strictObject({ rowId: id, fields: z.array(evidenceRefSchema).min(1).max(SUGGEST_LIMITS.maxEvidence) });

export const suggestRequestSchema = z.strictObject({
  requestId: id,
  generation: z.number().int().min(0),
  configurationHash: id,
  rows: z
    .array(z.strictObject({ left: rowFields, candidates: z.array(rowFields).min(1).max(SUGGEST_LIMITS.maxCandidates) }))
    .min(1)
    .max(SUGGEST_LIMITS.maxSuggestRows),
});

export const inferenceMetaSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  promptVersion: z.number().int(),
  durationMs: z.number().int(),
  attempts: z.number().int(),
  usage: z.strictObject({ inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable() }).nullable(),
});

export const suggestResponseSchema = z.strictObject({
  requestId: z.string(),
  generation: z.number().int(),
  configurationHash: z.string(),
  proposals: z.array(
    z.strictObject({
      leftId: z.string(),
      rightId: z.string().nullable(),
      outcome: z.enum(["suggest", "abstain"]),
      reasonCode: z.enum(["semantic_equivalence", "ambiguous", "insufficient_evidence"]),
      evidence: z.array(evidenceRefSchema).max(SUGGEST_LIMITS.maxEvidence),
      explanation: z.string().refine(codePoints(SUGGEST_LIMITS.maxExplanationChars), "too long"),
      generation: z.number().int(),
      configurationHash: z.string(),
    }),
  ),
  meta: inferenceMetaSchema,
});

export const API_ERROR_CODES = [
  "INVALID_INPUT",
  "PAYLOAD_TOO_LARGE",
  "BUSY",
  "NOT_CONFIGURED",
  "RATE_LIMITED",
  "MODEL_INVALID_OUTPUT",
  "UPSTREAM_ERROR",
  "TIMEOUT",
] as const;

// §8.3. `retryAfterSeconds` is present only when the server set Retry-After.
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
    retryAfterSeconds: z.number().int().optional(),
  }),
});

export type SuggestRequest = z.infer<typeof suggestRequestSchema>;
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;
export type InferenceMeta = z.infer<typeof inferenceMetaSchema>;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ---- client-side failure taxonomy ----

export type FailureCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "BUSY"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "MODEL_INVALID_OUTPUT"
  | "UPSTREAM_ERROR"
  | "SERVER_TIMEOUT"
  | "NETWORK"
  | "MALFORMED_RESPONSE"
  | "CONTRACT_MISMATCH"
  | "CLIENT_DEADLINE"
  | "CANCELLED";

// `batch` failures concern one request's rows and the run continues; `run` failures stop it.
export type FailureScope = "batch" | "run";

export type AnalysisFailure = {
  readonly code: FailureCode;
  readonly scope: FailureScope;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;
  readonly rowIds: readonly string[];
  readonly message: string; // fixed client text; never server, provider or cell content
};

const POLICY: Record<FailureCode, { scope: FailureScope; retryable: boolean; message: string }> = {
  INVALID_REQUEST: { scope: "run", retryable: false, message: "The analysis request was rejected as invalid." },
  PAYLOAD_TOO_LARGE: { scope: "batch", retryable: false, message: "These records are too large to send for AI review; review them manually." },
  BUSY: { scope: "run", retryable: true, message: "Another analysis request is running. Try again shortly." },
  NOT_CONFIGURED: { scope: "run", retryable: false, message: "AI suggestions are not configured on the API server." },
  RATE_LIMITED: { scope: "run", retryable: true, message: "The AI provider's rate limit was reached. Try again later." },
  MODEL_INVALID_OUTPUT: { scope: "batch", retryable: false, message: "The model could not produce a verified suggestion for these records." },
  UPSTREAM_ERROR: { scope: "run", retryable: false, message: "The AI provider returned an error." },
  SERVER_TIMEOUT: { scope: "run", retryable: true, message: "The AI request exceeded its 45 second deadline." },
  NETWORK: { scope: "run", retryable: true, message: "Could not reach the analysis API." },
  MALFORMED_RESPONSE: { scope: "run", retryable: false, message: "The analysis API returned an unreadable response." },
  CONTRACT_MISMATCH: { scope: "run", retryable: false, message: "The analysis API response did not match the request." },
  CLIENT_DEADLINE: { scope: "run", retryable: true, message: "The analysis pass reached its four minute limit; partial results were kept." },
  CANCELLED: { scope: "run", retryable: true, message: "Analysis was cancelled." },
};

export function failure(
  code: FailureCode,
  requestId: string | null,
  rowIds: readonly string[],
  server?: { retryable?: boolean; retryAfterSeconds?: number },
): AnalysisFailure {
  const p = POLICY[code];
  return {
    code,
    scope: p.scope,
    retryable: server?.retryable ?? p.retryable,
    retryAfterSeconds: server?.retryAfterSeconds ?? null,
    requestId,
    rowIds,
    message: p.message,
  };
}
