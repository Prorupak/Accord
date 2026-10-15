import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { replayAudit } from "./auditReplay";
import { isSnapshotCurrent, MATCH_FIELDS, prepareExport, protectCell, UNRESOLVED_FIELDS, type AuditV1, type ExportSnapshot } from "./exportSnapshot";
import { applyDecision, recordAnalysis, type ReconciliationState } from "./reconcile";
import { decision, rowA, rowB, setup } from "./testkit";

// Tamper tests edit parsed JSON, which is mutable even though the domain types are readonly.
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

const META = { appVersion: "test", generatedAt: "2026-10-15T00:00:00.000Z", runId: "run-1" };

function exported(s: ReconciliationState): ExportSnapshot {
  const r = prepareExport(s, META);
  if (!r.ok) throw new Error(`export failed: ${JSON.stringify(r.violations)}`);
  return r.snapshot;
}

const parseCsv = (text: string) => Papa.parse<string[]>(text, { header: false }).data;

describe("protectCell", () => {
  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1+1", "'+1+1"],
    ["-2+3+cmd|' /C calc'!A0", "'-2+3+cmd|' /C calc'!A0"],
    ["@SUM(1)", "'@SUM(1)"],
    ["\t=1", "'\t=1"],
    ["\r=1", "'\r=1"],
    ["  =1", "'  =1"],
    [" =1", "' =1"],
    ["\tplain", "'\tplain"],
  ])("prefixes %j with an apostrophe", (raw, expected) => expect(protectCell(raw)).toBe(expected));

  it.each(["-3", "-0.5", "00123", "Mug", "", "a=b", "1-2"])("leaves %j unchanged", (raw) => expect(protectCell(raw)).toBe(raw));
});

describe("prepareExport", () => {
  const base = () =>
    setup(
      'id,name,qty,unit\nP1,"=HYPERLINK(""x"")",-3,kg\n00123,mug,1,kg\n,cup,2,kg\n',
      "id,name,qty,unit\nP1,flask,2,KG\n00123,mug,1,\n,cup,2,kg\n",
      {
        A: { productId: "c0", name: "c1", quantity: "c2", unit: "c3" },
        B: { productId: "c0", name: "c1", quantity: "c2", unit: "c3" },
      },
    );

  it("writes fixed columns, CRLF endings, protected source text and raw computed deltas", async () => {
    const snap = exported(await base());
    const csv = snap.files["matches.csv"];
    expect(csv.split("\r\n")[0]).toBe(MATCH_FIELDS.join(","));
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
    const rows = parseCsv(csv);
    expect(rows[1][MATCH_FIELDS.indexOf("left_name")]).toBe(`'=HYPERLINK("x")`);
    expect(rows[1][MATCH_FIELDS.indexOf("left_quantity")]).toBe("-3");
    expect(rows[1][MATCH_FIELDS.indexOf("delta_b_minus_a")]).toBe("5");
    expect(rows[1][MATCH_FIELDS.indexOf("quantity_status")]).toBe("different");
    // Leading zeros stay as text; no ="00123" formula trick.
    expect(rows[2][MATCH_FIELDS.indexOf("left_product_id")]).toBe("00123");
    expect(csv).not.toContain('="');
    // Missing unit on one side: empty delta cell disambiguated by status, never zero.
    expect(rows[2][MATCH_FIELDS.indexOf("quantity_status")]).toBe("unit_unknown");
    expect(rows[2][MATCH_FIELDS.indexOf("delta_b_minus_a")]).toBe("");
  });

  it("keeps the unescaped source string in audit.json", async () => {
    const snap = exported(await base());
    const audit = JSON.parse(snap.files["audit.json"]) as AuditV1;
    expect(audit.datasets[0].rows[0].cells[1]).toBe('=HYPERLINK("x")');
  });

  it("lists every unpaired record from both sources in unresolved.csv", async () => {
    const snap = exported(await base());
    const rows = parseCsv(snap.files["unresolved.csv"]);
    expect(rows[0]).toEqual([...UNRESOLVED_FIELDS]);
    expect(rows.slice(1).map((r) => [r[0], r[2], r[7]])).toEqual([
      ["A", "2", "unpaired"],
      ["B", "2", "unpaired"],
    ]);
  });

  it("includes unanalyzed rows after a partial run as unresolved, with the analysis reason", async () => {
    const s = await setup("id,name,qty\n,blue cup,1\n,red cup,1\n", "id,name,qty\n,blue cup,1\n,red cup,1\n");
    const partial = recordAnalysis(s, s.generation, s.context.configurationHash, {
      status: "cancelled",
      selectedRowIds: [rowA(s, 0), rowA(s, 1)],
      analyzedRowIds: [rowA(s, 0)],
      failedRowIds: [],
    });
    const snap = exported(partial);
    expect(snap.unresolved.map((r) => r.reason_code)).toEqual(["unpaired", "analysis_cancelled", "unpaired", "unpaired"]);
    expect(snap.audit.analysis).toMatchObject({ status: "cancelled", analyzedRows: 1, eligibleRows: 2 });
  });

  it("builds all three artifacts from the same revision and goes stale after any edit", async () => {
    const s = await base();
    const snap = exported(s);
    expect(snap.audit.revision).toBe(s.revision);
    expect(isSnapshotCurrent(s, snap)).toBe(true);
    const edited = applyDecision(s, decision(s, "accept", rowA(s, 2), rowB(s, 2))).state;
    expect(isSnapshotCurrent(edited, snap)).toBe(false);
    const other = await setup("id,name,qty\nP1,a,1\n", "id,name,qty\nP1,a,1\n");
    expect(isSnapshotCurrent({ ...other, revision: s.revision }, snap)).toBe(false);
  });

  it("produces no artifacts when an invariant fails", async () => {
    const s = await base();
    const forged = { ...s, acceptedPairs: [...s.acceptedPairs, { ...s.acceptedPairs[0], id: "dup" }] };
    const r = prepareExport(forged, META);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("snapshot");
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain("row_reused");
  });
});

describe("replayAudit", () => {
  const scenario = async () => {
    const s0 = await setup(
      "id,name,qty\nP1,flask,12\n,cotton tote,8\nP3,mug,6\n,travel cup,4\n",
      "id,name,qty\nP1,bottle,12\n,cotton bag,8\nP3,mug,5\n,travel tumbler,4\n",
    );
    const s1 = applyDecision(s0, decision(s0, "accept", rowA(s0, 1), rowB(s0, 1))).state;
    const s2 = applyDecision(s1, decision(s1, "exclude_exact", rowA(s0, 0), rowB(s0, 0))).state;
    const s3 = applyDecision(s2, decision(s2, "reject", rowA(s0, 3), rowB(s0, 3))).state;
    const snap = exported(s3);
    return { snap, audit: JSON.parse(snap.files["audit.json"]) as Mutable<AuditV1> };
  };

  it("reproduces the exported canonical CSVs without inference", async () => {
    const { snap, audit } = await scenario();
    const r = await replayAudit(audit);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.files["matches.csv"]).toBe(snap.files["matches.csv"]);
      expect(r.value.files["unresolved.csv"]).toBe(snap.files["unresolved.csv"]);
    }
  });

  const tamper: Array<[string, (a: Mutable<AuditV1>) => unknown, string]> = [
    ["a non-object", () => "nope", "schema"],
    ["an unknown field", (a) => ({ ...a, extra: 1 }), "schema"],
    ["a changed source cell", (a) => { a.datasets[0].rows[2].cells[0] = "P9"; }, "mismatch"],
    ["an edited configuration", (a) => { a.configuration.idCaseSensitive = false; }, "configuration_hash"],
    ["a forged row ID", (a) => { a.datasets[1].rows[0].id = "B:x:0"; }, "dataset"],
    ["swapped datasets", (a) => { a.datasets.reverse(); }, "dataset"],
    ["an accepted pair without a decision", (a) => { a.decisions.splice(0, 1); }, "mismatch"],
    ["a pair pointing at a different row", (a) => { a.acceptedPairs[0].rightId = a.datasets[1].rows[3].id; }, "mismatch"],
    ["a duplicated pair", (a) => { a.acceptedPairs.push(a.acceptedPairs[0]); }, "mismatch"],
    ["a decision referencing a nonexistent row", (a) => { a.decisions[0].rightId = "B:nope:9"; }, "decision"],
    ["a repeated decision", (a) => { a.decisions.push(a.decisions[0]); }, "decision"],
    ["a dropped unmatched row", (a) => { a.unmatched.pop(); }, "mismatch"],
    ["an altered unresolved reason", (a) => { a.unmatched[0].reason = "ambiguous"; }, "mismatch"],
    ["a removed exclusion", (a) => { a.excludedExactPairs = []; }, "mismatch"],
    ["inflated invariant counts", (a) => { a.invariants.pairCount = 9; }, "mismatch"],
    ["a stale decision hash", (a) => { a.decisions[0].configurationHash = "0".repeat(64); }, "decision"],
  ];

  it.each(tamper)("rejects an audit with %s", async (_label, mutate, code) => {
    const { audit } = await scenario();
    const copy = structuredClone(audit);
    const replaced = mutate(copy);
    const r = await replayAudit(replaced ?? copy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});
