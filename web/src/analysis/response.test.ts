import { describe, expect, it } from "vitest";
import { analysisEligibleRows } from "../domain/exportSnapshot";
import { confirmed, rec } from "../workflow/testkit";
import type { SuggestRequest, SuggestResponse } from "./contract";
import { buildSuggestRequest } from "./request";
import { readSuggestResponse } from "./response";
import { abstain, apiError, META, ok, responseBody, suggestFirst, widgets } from "./testkit";

async function request(): Promise<SuggestRequest> {
  const w = widgets(2);
  const s = await confirmed(w.a, w.b);
  const built = buildSuggestRequest(rec(s), analysisEligibleRows(rec(s)), "req-1");
  if (!built.ok) throw new Error(built.error.code);
  return built.value.request;
}

const send = (req: SuggestRequest, body: unknown, status = 200) => readSuggestResponse(req, { status, body: JSON.stringify(body) });
const code = (r: ReturnType<typeof readSuggestResponse>) => (r.ok ? "ok" : r.error.code);

describe("readSuggestResponse", () => {
  it("normalizes a valid response into a proposal batch in request order", async () => {
    const req = await request();
    const r = readSuggestResponse(req, ok(req, (row) => (row === req.rows[0] ? suggestFirst(row) : abstain(row))));
    if (!r.ok) throw new Error(r.error.code);
    expect(r.batch).toMatchObject({ requestId: "req-1", generation: req.generation, configurationHash: req.configurationHash });
    expect(r.batch.proposals.map((p) => [p.leftId, p.outcome])).toEqual([
      [req.rows[0].left.rowId, "suggest"],
      [req.rows[1].left.rowId, "abstain"],
    ]);
    expect(r.batch.proposals[0]).not.toHaveProperty("generation");
    expect(r.meta).toEqual(META);
  });

  it("accepts null usage and null token counts", async () => {
    const req = await request();
    expect(code(readSuggestResponse(req, ok(req, suggestFirst, { ...META, usage: null })))).toBe("ok");
    expect(code(readSuggestResponse(req, ok(req, suggestFirst, { ...META, usage: { inputTokens: null, outputTokens: 7 } })))).toBe("ok");
  });

  it("rejects unreadable and structurally wrong bodies", async () => {
    const req = await request();
    const good = responseBody(req);
    expect(code(readSuggestResponse(req, { status: 200, body: "<html>" }))).toBe("MALFORMED_RESPONSE");
    expect(code(send(req, { ...good, extra: 1 }))).toBe("CONTRACT_MISMATCH");
    expect(code(send(req, { ...good, meta: { ...META, promptVersion: "1" } }))).toBe("CONTRACT_MISMATCH");
    expect(code(send(req, { ...good, proposals: [{ ...good.proposals[0], confidence: 0.9 }, good.proposals[1]] }))).toBe("CONTRACT_MISMATCH");
    expect(code(send(req, { ...good, proposals: [{ ...good.proposals[0], explanation: "x".repeat(241) }, good.proposals[1]] }))).toBe("CONTRACT_MISMATCH");
  });

  it.each([
    ["requestId", (b: SuggestResponse) => ({ ...b, requestId: "other" })],
    ["generation", (b: SuggestResponse) => ({ ...b, generation: b.generation + 1 })],
    ["configurationHash", (b: SuggestResponse) => ({ ...b, configurationHash: "f".repeat(64) })],
    ["a proposal's generation", (b: SuggestResponse) => ({ ...b, proposals: [{ ...b.proposals[0], generation: 99 }, b.proposals[1]] })],
  ])("rejects a wrong %s echo", async (_l, mutate) => {
    const req = await request();
    expect(code(send(req, mutate(responseBody(req))))).toBe("CONTRACT_MISMATCH");
  });

  it("rejects missing, duplicate and invented results", async () => {
    const req = await request();
    const b = responseBody(req);
    expect(code(send(req, { ...b, proposals: [b.proposals[0]] }))).toBe("MODEL_INVALID_OUTPUT");
    expect(code(send(req, { ...b, proposals: [b.proposals[0], b.proposals[0]] }))).toBe("MODEL_INVALID_OUTPUT");
    expect(code(send(req, { ...b, proposals: [b.proposals[0], { ...b.proposals[1], leftId: "A:invented:1" }] }))).toBe("MODEL_INVALID_OUTPUT");
    const r = send(req, { ...b, proposals: [b.proposals[0]] });
    expect(r.ok ? null : r).toMatchObject({ error: { scope: "batch", rowIds: req.rows.map((x) => x.left.rowId) }, meta: META });
  });

  it("rejects unknown candidates, inconsistent outcomes and forged or misattributed evidence", async () => {
    const req = await request();
    const [row] = req.rows;
    const bad = (patch: Partial<SuggestResponse["proposals"][number]>) => {
      const b = responseBody(req);
      return code(send(req, { ...b, proposals: [{ ...b.proposals[0], ...patch }, b.proposals[1]] }));
    };
    expect(bad({ rightId: req.rows[1].left.rowId.replace("A:", "B:") })).toBe("MODEL_INVALID_OUTPUT");
    expect(bad({ rightId: null })).toBe("MODEL_INVALID_OUTPUT");
    expect(bad({ reasonCode: "ambiguous" })).toBe("MODEL_INVALID_OUTPUT");
    expect(bad({ outcome: "abstain", rightId: null })).toBe("MODEL_INVALID_OUTPUT"); // abstain with semantic_equivalence
    expect(bad({ outcome: "abstain", reasonCode: "ambiguous" })).toBe("MODEL_INVALID_OUTPUT"); // abstain naming a candidate
    expect(bad({ evidence: [row.left.fields[0]] })).toBe("MODEL_INVALID_OUTPUT"); // one-sided
    expect(bad({ evidence: [{ ...row.left.fields[0], value: "Widget model 0 " }, row.candidates[0].fields[0]] })).toBe("MODEL_INVALID_OUTPUT");
    expect(bad({ evidence: [{ ...row.left.fields[0], columnId: "c2" }, row.candidates[0].fields[0]] })).toBe("MODEL_INVALID_OUTPUT");
    // A suggestion may cite only its chosen candidate, not another supplied one.
    expect(bad({ evidence: [row.left.fields[0], row.candidates[0].fields[0], row.candidates[1].fields[0]] })).toBe("MODEL_INVALID_OUTPUT");
    // An abstention may cite competing candidates it was given.
    expect(bad({ outcome: "abstain", rightId: null, reasonCode: "ambiguous", evidence: [row.candidates[0].fields[0], row.candidates[1].fields[0]] })).toBe("ok");
  });

  it.each([
    [400, "INVALID_INPUT", "INVALID_REQUEST", "run", false],
    [413, "PAYLOAD_TOO_LARGE", "PAYLOAD_TOO_LARGE", "batch", false],
    [409, "BUSY", "BUSY", "run", true],
    [503, "NOT_CONFIGURED", "NOT_CONFIGURED", "run", false],
    [429, "RATE_LIMITED", "RATE_LIMITED", "run", true],
    [502, "MODEL_INVALID_OUTPUT", "MODEL_INVALID_OUTPUT", "batch", false],
    [502, "UPSTREAM_ERROR", "UPSTREAM_ERROR", "run", true],
    [504, "TIMEOUT", "SERVER_TIMEOUT", "run", true],
  ] as const)("classifies %i %s", async (status, server, expected, scope, retryable) => {
    const req = await request();
    const r = readSuggestResponse(req, apiError(status, server, req, { retryable, ...(server === "RATE_LIMITED" ? { retryAfterSeconds: 7 } : {}) }));
    expect(r.ok ? null : r.error).toMatchObject({ code: expected, scope, retryable, requestId: "req-1" });
    if (!r.ok) expect(r.error.message).not.toContain("server text");
    if (server === "RATE_LIMITED" && !r.ok) expect(r.error.retryAfterSeconds).toBe(7);
  });

  it("treats an inconsistent or unknown error envelope as a contract mismatch", async () => {
    const req = await request();
    expect(code(readSuggestResponse(req, apiError(500, "BUSY", req)))).toBe("CONTRACT_MISMATCH");
    expect(code(readSuggestResponse(req, apiError(418, "TEAPOT", req)))).toBe("CONTRACT_MISMATCH");
    expect(code(readSuggestResponse(req, { ...apiError(409, "BUSY", null) }))).toBe("BUSY"); // requestId "" allowed
    expect(code(readSuggestResponse(req, { status: 409, body: JSON.stringify({ error: { code: "BUSY", message: "", retryable: true, requestId: "someone-else" } }) }))).toBe(
      "CONTRACT_MISMATCH",
    );
    expect(code(readSuggestResponse(req, { status: 500, body: "Internal Server Error" }))).toBe("MALFORMED_RESPONSE");
  });
});
