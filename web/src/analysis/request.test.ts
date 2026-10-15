import { describe, expect, it } from "vitest";
import { AI_CONTEXT_MAX_CODE_POINTS, contextFields, projectContext } from "../domain/aiContext";
import { candidatesFor } from "../domain/candidates";
import { analysisEligibleRows } from "../domain/exportSnapshot";
import { setup } from "../domain/testkit";
import { confirmed, rec, rowA, rowB } from "../workflow/testkit";
import { suggestRequestSchema } from "./contract";
import { buildSuggestRequest, utf8Bytes } from "./request";
import { widgets } from "./testkit";

describe("projectContext", () => {
  it("keeps short cells whole and clips long ones to 160 code points without splitting surrogate pairs", () => {
    expect(projectContext("Ceramic mug")).toBe("Ceramic mug");
    const emoji = "x".repeat(159) + "😀😀";
    const clipped = projectContext(emoji);
    expect(clipped).toBe("x".repeat(159) + "😀");
    expect(Array.from(clipped)).toHaveLength(AI_CONTEXT_MAX_CODE_POINTS);
    expect(clipped.length).toBe(161); // UTF-16 units differ from code points
    expect(emoji.startsWith(clipped)).toBe(true);
  });
});

describe("buildSuggestRequest", () => {
  it("sends only mapped name and product-ID cells with real row and column IDs, never quantities", async () => {
    const s = await confirmed();
    const r = rec(s);
    const rows = [rowA(s, 1), rowA(s, 3)];
    const built = buildSuggestRequest(r, rows, "req-1");
    if (!built.ok) throw new Error(built.error.code);
    const { request, body } = built.value;
    expect(suggestRequestSchema.parse(JSON.parse(body))).toEqual(request);
    expect(request).toMatchObject({ requestId: "req-1", generation: r.generation, configurationHash: r.context.configurationHash });
    expect(request.rows.map((x) => x.left.rowId)).toEqual(rows);
    // The tote has no product ID: only its name is sent. Quantities (c2) never appear.
    expect(request.rows[0].left.fields).toEqual([{ side: "A", rowId: rowA(s, 1), columnId: "c1", value: "Organic cotton tote natural" }]);
    const all = request.rows.flatMap((x) => [x.left, ...x.candidates]).flatMap((o) => o.fields);
    expect(new Set(all.map((f) => f.columnId))).toEqual(new Set(["c1"]));
    expect(body).not.toMatch(/"c2"/);
    for (const row of request.rows)
      expect(row.candidates.map((c) => c.rowId)).toEqual(candidatesFor(r, row.left.rowId).map((c) => c.rightId));
    expect(request.rows[0].candidates[0].rowId).toBe(rowB(s, 1));
  });

  it("includes a nonblank product ID", async () => {
    const r = await setup("id,name,qty\nA7,blue mug,1\n", "id,name,qty\n,blue mug large,2\n");
    const id = r.context.datasets.A.rows[0].id;
    expect(contextFields(r.context, id)).toEqual([
      { side: "A", rowId: id, columnId: "c1", value: "blue mug" },
      { side: "A", rowId: id, columnId: "c0", value: "A7" },
    ]);
    const built = buildSuggestRequest(r, [id], "r");
    expect(built.ok && built.value.request.rows[0].candidates[0].fields.map((f) => f.columnId)).toEqual(["c1"]);
  });

  it("caps rows at five and refuses rows without candidates or no rows at all", async () => {
    const w = widgets(7);
    const s = await confirmed(w.a, w.b);
    const ids = analysisEligibleRows(rec(s));
    expect(buildSuggestRequest(rec(s), ids.slice(0, 6), "r").ok).toBe(false);
    expect(buildSuggestRequest(rec(s), [], "r")).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const five = buildSuggestRequest(rec(s), ids.slice(0, 5), "r");
    expect(five.ok && five.value.request.rows.every((x) => x.candidates.length === 5)).toBe(true);

    const lonely = await confirmed("sku,item,qty\n,sofa,1\n,blue mug,1\n", "code,desc,stock\n,blue mug,1\n");
    expect(buildSuggestRequest(rec(lonely), [rowA(lonely, 0)], "r")).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("measures the UTF-8 body, not the JavaScript string length", async () => {
    const name = "杯".repeat(150);
    const s = await confirmed(`sku,item,qty\n,${name} a,1\n`, `code,desc,stock\n,${name} b,1\n`);
    const built = buildSuggestRequest(rec(s), [rowA(s, 0)], "r");
    if (!built.ok) throw new Error(built.error.code);
    const { body, bytes } = built.value;
    expect(bytes).toBe(utf8Bytes(body));
    expect(bytes).toBeGreaterThan(body.length + 500);
    // A limit the string length fits under but the byte length does not.
    const over = buildSuggestRequest(rec(s), [rowA(s, 0)], "r", body.length + 1);
    expect(over).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE", scope: "batch", rowIds: [rowA(s, 0)] } });
  });

  it("clips long cells in outbound context only", async () => {
    const long = "Organic cotton tote ".repeat(10).trim();
    const s = await confirmed(`sku,item,qty\n,${long},1\n`, "code,desc,stock\n,Organic cotton bag,1\n");
    const built = buildSuggestRequest(rec(s), [rowA(s, 0)], "r");
    if (!built.ok) throw new Error(built.error.code);
    const sent = built.value.request.rows[0].left.fields[0].value;
    expect(Array.from(sent)).toHaveLength(160);
    expect(long.startsWith(sent)).toBe(true);
    expect(rec(s).context.rows.get(rowA(s, 0))!.name).toBe(long);
  });
});
