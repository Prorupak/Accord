import { describe, expect, it } from "vitest";
import { sha256Hex } from "./identity";
import { parseDataset } from "./parseCsv";
import type { Dataset } from "./types";

const enc = (s: string) => new TextEncoder().encode(s);

async function ok(text: string | Uint8Array, side: "A" | "B" = "A"): Promise<Dataset> {
  const r = await parseDataset(side, "f.csv", typeof text === "string" ? enc(text) : text);
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}`);
  return r.value;
}

async function errCode(text: string | Uint8Array) {
  const r = await parseDataset("A", "f.csv", typeof text === "string" ? enc(text) : text);
  if (r.ok) throw new Error("expected failure");
  return r.error.code;
}

describe("parseDataset", () => {
  it("parses BOM + CRLF + quoted comma and hashes the original bytes, BOM included", async () => {
    const bytes = enc('﻿sku,name\r\nP1,"Mug, white"\r\n');
    const d = await ok(bytes);
    expect(d.columns.map((c) => c.header)).toEqual(["sku", "name"]);
    expect(d.rows[0].cells).toEqual(["P1", "Mug, white"]);
    expect(d.id).toBe(await sha256Hex(bytes));
    expect(d.id).not.toBe(await sha256Hex(enc('sku,name\r\nP1,"Mug, white"\r\n')));
    expect(d.byteLength).toBe(bytes.byteLength);
  });

  it("keeps a quoted multiline cell in one record and indexes by data record, not physical line", async () => {
    const d = await ok('id,name\n1,"line one\nline two"\n2,next\n');
    expect(d.rows).toHaveLength(2);
    expect(d.rows[0].cells[1]).toBe("line one\nline two");
    expect(d.rows[1].index).toBe(1);
    expect(d.rows[1].id.endsWith(":1")).toBe(true);
  });

  it("assigns c0.. column IDs and side-qualified row IDs", async () => {
    const d = await ok("a,b\n1,2\n", "B");
    expect(d.columns.map((c) => c.id)).toEqual(["c0", "c1"]);
    expect(d.rows[0].id).toBe(`B:${d.id}:0`);
  });

  it("gives identical files different row IDs on A and B but the same dataset ID", async () => {
    const a = await ok("a,b\n1,2\n", "A");
    const b = await ok("a,b\n1,2\n", "B");
    expect(a.id).toBe(b.id);
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
  });

  it("preserves raw strings: leading zeros, surrounding spaces, numeric-looking values", async () => {
    const d = await ok("id,qty\n00123, 1.50 \n");
    expect(d.rows[0].cells).toEqual(["00123", " 1.50 "]);
  });

  it("counts blank lines separately and keeps empty-valued records like ',,'", async () => {
    const d = await ok("a,b,c\n\n1,2,3\n\n,,\n");
    expect(d.parse.ignoredBlankRecords).toBe(2);
    expect(d.rows.map((r) => r.cells)).toEqual([["1", "2", "3"], ["", "", ""]]);
    expect(d.rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it("does not count the final line terminator as a blank record", async () => {
    expect((await ok("a,b\n1,2\n")).parse.ignoredBlankRecords).toBe(0);
    expect((await ok("a,b\n1,2")).parse.ignoredBlankRecords).toBe(0);
  });

  it("handles a __proto__ header as plain array data without prototype mutation", async () => {
    const d = await ok("__proto__,constructor\npolluted,x\n");
    expect(d.columns[0].header).toBe("__proto__");
    expect(d.rows[0].cells[0]).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("freezes parsed data so source values cannot be mutated", async () => {
    const d = await ok("a,b\n1,2\n");
    expect(Object.isFrozen(d.rows[0].cells)).toBe(true);
    expect(Object.isFrozen(d.rows)).toBe(true);
  });

  it.each([
    ["empty file", "", "empty_file"],
    ["header only", "a,b\n", "record_count"],
    ["blank first line", "\na,b\n1,2\n", "missing_header"],
    ["one column", "a\n1\n", "column_count"],
    ["thirteen columns", `${Array.from({ length: 13 }, (_, i) => `h${i}`).join(",")}\n${",".repeat(12)}\n`, "column_count"],
    ["empty header cell", "a, \n1,2\n", "empty_header"],
    ["duplicate header after trim/case fold", "Name, name \n1,2\n", "duplicate_header"],
    ["row wider than header", "a,b\n1,2,3\n", "row_width"],
    ["row narrower than header", "a,b,c\n1,2\n", "row_width"],
    ["whitespace-only line is not blank", "a,b\n1,2\n   \n", "row_width"],
    ["unterminated quote", 'a,b\n1,"open\n', "malformed_quotes"],
    ["text after closing quote", 'a,b\n1,"x"y\n', "malformed_quotes"],
    ["NUL byte", "a,b\n1,\u00002\n", "binary_content"],
    ["mixed CRLF/LF outside quotes", "a,b\n1,2\r\n3,4\n", "mixed_line_endings"],
  ])("rejects %s", async (_label, text, code) => {
    expect(await errCode(text)).toBe(code);
  });

  it("rejects invalid UTF-8 instead of substituting replacement characters", async () => {
    expect(await errCode(new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0x2c, 0x31, 0x0a]))).toBe("invalid_utf8");
  });

  it("enforces the 262,144-byte limit exactly", async () => {
    // One row with a huge cell would exceed the cell limit, so build many 2,000-character rows.
    const build = (total: number) => {
      let s = "a,b\n";
      while (s.length + 2_003 <= total) s += `${"x".repeat(2_000)},y\n`;
      return s + `z,${"w".repeat(total - s.length - 3)}\n`;
    };
    expect(await errCode(build(262_145))).toBe("file_too_large");
    const atLimit = build(262_144);
    expect(enc(atLimit).byteLength).toBe(262_144);
    expect((await ok(atLimit)).byteLength).toBe(262_144);
  });

  it("accepts 200 records and rejects 201", async () => {
    const rows = (n: number) => "a,b\n" + Array.from({ length: n }, (_, i) => `${i},x`).join("\n");
    expect((await ok(rows(200))).rows).toHaveLength(200);
    expect(await errCode(rows(201))).toBe("record_count");
  });

  it("counts cell length in Unicode code points, not UTF-16 units", async () => {
    const astral = "😀"; // 1 code point, 2 UTF-16 units
    expect((await ok(`a,b\n${astral.repeat(2_048)},1\n`)).rows[0].cells[0]).toHaveLength(4_096);
    expect(await errCode(`a,b\n${astral.repeat(2_049)},1\n`)).toBe("cell_too_long");
  });

  it("reports locations but never cell contents in error messages", async () => {
    const r = await parseDataset("A", "f.csv", enc("a,b\nSECRETVALUE,2,3\n"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.recordIndex).toBe(0);
      expect(r.error.message).not.toContain("SECRETVALUE");
    }
  });
});
