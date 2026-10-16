// Cross-language drift check: the same fixtures are validated by api/tests/test_contract_fixtures.py.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiErrorSchema, SUGGEST_LIMITS, suggestRequestSchema, suggestResponseSchema } from "./contract";
import { readSuggestResponse } from "./response";

const load = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/contracts/suggest", `${name}.json`), "utf8"));

describe("shared /api/suggest contract fixtures", () => {
  it("parse strictly and unchanged", () => {
    expect(suggestRequestSchema.parse(load("request"))).toEqual(load("request"));
    expect(suggestResponseSchema.parse(load("response"))).toEqual(load("response"));
    expect(apiErrorSchema.parse(load("error-rate-limited"))).toEqual(load("error-rate-limited"));
    expect(apiErrorSchema.parse(load("error-not-configured"))).toEqual(load("error-not-configured"));
  });

  it("validate end to end: the fixture response is accepted for the fixture request", () => {
    const request = suggestRequestSchema.parse(load("request"));
    const r = readSuggestResponse(request, { status: 200, body: JSON.stringify(load("response")) });
    expect(r.ok && r.batch.proposals.map((p) => p.outcome)).toEqual(["suggest", "abstain"]);
  });

  it("share the server limits", () => {
    const { maxBodyBytes, maxIdChars, maxCellChars, maxSuggestRows, maxCandidates, maxEvidence, maxExplanationChars } = SUGGEST_LIMITS;
    expect(load("limits")).toEqual({ maxBodyBytes, maxIdChars, maxCellChars, maxSuggestRows, maxCandidates, maxEvidence, maxExplanationChars });
  });
});
