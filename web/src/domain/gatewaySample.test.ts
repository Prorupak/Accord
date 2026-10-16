import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseDataset } from "./parseCsv";

// gateway/src/sample.json is the hosted gateway's allowlist: the only values it lets reach the
// model. It must be exactly what this parser produces for the built-in sample, or hosted AI breaks.
// Regenerate after a fixture or parser change: UPDATE_GATEWAY_SAMPLE=1 pnpm test gatewaySample
const root = new URL("../../../", import.meta.url);
const SAMPLE = { A: "source-a.csv", B: "source-b.csv" } as const;

test("gateway sample allowlist matches the parser's view of fixtures/inventory", async () => {
  const sides: Record<string, unknown> = {};
  for (const [side, name] of Object.entries(SAMPLE) as ["A" | "B", string][]) {
    const parsed = await parseDataset(side, name, readFileSync(new URL(`fixtures/inventory/${name}`, root)));
    if (!parsed.ok) throw new Error(`${name}: ${parsed.error.code}`);
    const d = parsed.value;
    sides[side] = {
      datasetId: d.id,
      columns: d.columns.map((c) => ({ id: c.id, header: c.header })),
      rows: d.rows.map((r) => ({ id: r.id, cells: [...r.cells] })),
    };
  }
  const want = `${JSON.stringify(sides, null, 2)}\n`;
  const file = new URL("gateway/src/sample.json", root);
  if (process.env.UPDATE_GATEWAY_SAMPLE) writeFileSync(file, want);
  expect(readFileSync(file, "utf8")).toBe(want);
});
