// Test double for /api/suggest on the canonical fixture (spec §13.1), used by the jsdom and
// Playwright tests only. It answers from the request it receives, citing only supplied values:
// tote → bag is suggested; anything else (the travel cup) abstains as ambiguous. Its metadata
// names it as a test double so it can never be mistaken for a live model run.
import type { InferenceMeta, SuggestRequest, SuggestResponse } from "../src/analysis/contract";

export const TEST_META: InferenceMeta = {
  provider: "test-double",
  model: "deterministic-canonical",
  promptVersion: 1,
  durationMs: 1,
  attempts: 1,
  usage: null,
};

type Row = SuggestRequest["rows"][number];

function decide(row: Row): Omit<SuggestResponse["proposals"][number], "generation" | "configurationHash"> {
  const tote = row.left.fields.find((f) => /tote/i.test(f.value));
  const bag = row.candidates.find((c) => c.fields.some((f) => /bag/i.test(f.value)));
  if (tote && bag)
    return {
      leftId: row.left.rowId,
      rightId: bag.rowId,
      outcome: "suggest",
      reasonCode: "semantic_equivalence",
      evidence: [tote, bag.fields.find((f) => /bag/i.test(f.value))!],
      explanation: "Both describe a natural cotton bag.",
    };
  return {
    leftId: row.left.rowId,
    rightId: null,
    outcome: "abstain",
    reasonCode: "ambiguous",
    evidence: [row.left.fields[0], ...row.candidates.map((c) => c.fields[0])].slice(0, 6),
    explanation: "Both candidates are plausible. The source does not specify a capacity.",
  };
}

export function canonicalSuggestResponse(body: string): string {
  const request = JSON.parse(body) as SuggestRequest;
  const { requestId, generation, configurationHash } = request;
  const response: SuggestResponse = {
    requestId,
    generation,
    configurationHash,
    proposals: request.rows.map((r) => ({ ...decide(r), generation, configurationHash })),
    meta: TEST_META,
  };
  return JSON.stringify(response);
}

export const errorEnvelope = (code: string, body: string) =>
  JSON.stringify({ error: { code, message: "provider detail", retryable: false, requestId: (JSON.parse(body) as { requestId: string }).requestId } });
