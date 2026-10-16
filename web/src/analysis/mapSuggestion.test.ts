import { describe, expect, it } from "vitest";
import { dataset } from "../domain/testkit";
import { SOURCE_A, SOURCE_B } from "../workflow/testkit";
import { buildMapRequest, MAX_MAP_SAMPLES, requestMapSuggestion, type MapRequest } from "./mapSuggestion";
import type { HttpResult } from "./response";
import type { Transport } from "./runner";
import { META } from "./testkit";

const many = ["sku,item,qty", ...Array.from({ length: 9 }, (_, i) => `S${i},Item ${i},${i}`)].join("\n") + "\n";
const datasets = async () => ({ A: await dataset("A", many), B: await dataset("B", SOURCE_B) });

const explanations = { productId: "Looks like codes.", name: "Values resemble product names.", quantity: "Integers.", unit: "No unit column." };
const mapping = { productId: "c0", name: "c1", quantity: "c2", unit: null };
const okBody = (req: MapRequest, override: Record<string, unknown> = {}) =>
  JSON.stringify({ requestId: req.requestId, generation: req.generation, A: { mapping, explanations }, B: { mapping, explanations }, warnings: [], meta: META, ...override });

function transport(respond: (req: MapRequest) => HttpResult | Promise<HttpResult>) {
  const sent: MapRequest[] = [];
  const t: Transport = async (body) => {
    const req = JSON.parse(body) as MapRequest;
    sent.push(req);
    return respond(req);
  };
  return { t, sent };
}

const run = async (respond: Parameters<typeof transport>[0]) => {
  const { t, sent } = transport(respond);
  const r = await requestMapSuggestion(await datasets(), { requestId: "m1", generation: 3, signal: new AbortController().signal, transport: t });
  return { r, sent };
};

describe("map suggestions", () => {
  it("sends headers and at most five real sample records per side", async () => {
    const d = await datasets();
    const req = buildMapRequest(d, "m1", 0);
    expect(req.datasets.map((x) => x.side)).toEqual(["A", "B"]);
    expect(req.datasets[0].samples).toHaveLength(MAX_MAP_SAMPLES);
    expect(req.datasets[0].samples.map((s) => s.rowId)).toEqual(d.A.rows.slice(0, 5).map((r) => r.id));
    expect(req.datasets[1].columns).toEqual([
      { id: "c0", header: "product_code" },
      { id: "c1", header: "description" },
      { id: "c2", header: "stock" },
    ]);
  });

  it("returns a draft with explanations from a valid response", async () => {
    const { r } = await run((req) => ({ status: 200, body: okBody(req) }));
    expect(r).toMatchObject({ ok: true, value: { draft: { A: mapping, B: mapping }, explanations: { A: explanations } } });
  });

  it.each([
    ["an unknown column", { A: { mapping: { ...mapping, unit: "c9" }, explanations } }, "MODEL_INVALID_OUTPUT"],
    ["a reused column", { B: { mapping: { ...mapping, quantity: "c1" }, explanations } }, "MODEL_INVALID_OUTPUT"],
    ["a wrong request ID", { requestId: "other" }, "CONTRACT_MISMATCH"],
    ["a wrong generation", { generation: 99 }, "CONTRACT_MISMATCH"],
    ["an extra field", { extra: true }, "CONTRACT_MISMATCH"],
  ])("rejects %s", async (_, override, code) => {
    const { r } = await run((req) => ({ status: 200, body: okBody(req, override) }));
    expect(r).toMatchObject({ ok: false, error: { code } });
  });

  it.each([
    [503, "NOT_CONFIGURED", "NOT_CONFIGURED"],
    [502, "UPSTREAM_ERROR", "UPSTREAM_ERROR"],
    [429, "RATE_LIMITED", "RATE_LIMITED"],
  ])("maps HTTP %s %s to a typed failure", async (status, code, expected) => {
    const { r, sent } = await run((req) => ({
      status,
      body: JSON.stringify({ error: { code, message: "provider text", retryable: false, requestId: req.requestId } }),
    }));
    expect(r).toMatchObject({ ok: false, error: { code: expected } });
    expect(r.ok || r.error.message).not.toContain("provider text");
    expect(sent).toHaveLength(1);
  });

  it("reports network and unreadable responses without retrying", async () => {
    const net = await run(() => Promise.reject(new TypeError("fetch failed")));
    expect(net.r).toMatchObject({ ok: false, error: { code: "NETWORK" } });
    expect(net.sent).toHaveLength(1);
    const bad = await run(() => ({ status: 200, body: "<html>" }));
    expect(bad.r).toMatchObject({ ok: false, error: { code: "MALFORMED_RESPONSE" } });
  });

  it("keeps sample cells exactly as parsed", async () => {
    const d = { A: await dataset("A", SOURCE_A), B: await dataset("B", SOURCE_B) };
    expect(buildMapRequest(d, "m", 0).datasets[0].samples[1].cells).toEqual(["", "Organic cotton tote natural", "8"]);
  });
});
