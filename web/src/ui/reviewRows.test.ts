import { describe, expect, it } from "vitest";
import { batch, confirmed, decide, reduce, rec, rowA, rowB, suggestion } from "../workflow/testkit";
import { filterCount, matchesFilter, matchesQuery, reviewRows, statusLabel, statusTone } from "./reviewRows";

const kinds = (s: Awaited<ReturnType<typeof confirmed>>) => reviewRows(rec(s)).map((r) => `${r.kind}:${r.key}`);

describe("reviewRows", () => {
  it("lists Source A in record order, then unmatched Source B, with exact pairs and the P03 delta", async () => {
    const s = await confirmed();
    const rows = reviewRows(rec(s));
    expect(kinds(s)).toEqual([
      `pair:${rowA(s, 0)}`,
      `unresolved:${rowA(s, 1)}`,
      `pair:${rowA(s, 2)}`,
      `unresolved:${rowA(s, 3)}`,
      `unresolved:${rowB(s, 1)}`,
      `unresolved:${rowB(s, 3)}`,
    ]);
    const p03 = rows[2];
    expect(p03.kind === "pair" && p03.comparison).toMatchObject({ status: "different", delta: "-1" });
    expect(statusLabel(p03)).toBe("Matched by product ID");
    expect(rows[0].kind === "pair" && rows[0].comparison.status).toBe("equal");
  });

  it("shows a pending suggestion as needing review until it is decided", async () => {
    const s0 = reduce(await confirmed(), { type: "analysis/started" });
    const s = reduce(s0, batch(s0, "r1", [suggestion(s0, rowA(s0, 1), rowB(s0, 1))], [rowA(s0, 1)]));
    const tote = reviewRows(rec(s))[1];
    expect(tote).toMatchObject({ kind: "pending", proposal: { rightId: rowB(s, 1) } });
    expect(matchesFilter(tote, "needs_review")).toBe(true);
    expect(statusLabel(tote)).toBe("Suggested pair: needs your review");

    const p = rec(s).proposals[0];
    const accepted = reduce(s, decide(s, "accept", rowA(s, 1), rowB(s, 1), { proposalId: p.id }));
    expect(reviewRows(rec(accepted))[1]).toMatchObject({ kind: "pair", pair: { method: "ai_reviewed" } });
    const rejected = reduce(s, decide(s, "reject", rowA(s, 1), rowB(s, 1), { proposalId: p.id }));
    expect(reviewRows(rec(rejected))[1]).toMatchObject({ kind: "unresolved", unresolved: { reason: "rejected" } });
  });

  it("filters identifier conflicts", async () => {
    const s = await confirmed("sku,item,qty\nX1,Mug,1\nX1,Mug large,2\nY1,Cup,3\n", "code,desc,stock\nZ9,Cup,3\nQ1,Plate,1\n");
    const rows = reviewRows(rec(s));
    const conflicts = rows.filter((r) => matchesFilter(r, "conflicts")).map((r) => r.kind === "unresolved" && r.unresolved.reason);
    expect(conflicts).toEqual(["duplicate_id", "duplicate_id", "conflicting_id"]);
    expect(rows.filter((r) => matchesFilter(r, "matched"))).toEqual([]);
  });

  it("counts filters, searches a row's own and counterpart names and IDs, and tones each state", async () => {
    const s = await confirmed();
    const rows = reviewRows(rec(s));
    expect([filterCount(rows, "all"), filterCount(rows, "matched"), filterCount(rows, "unresolved"), filterCount(rows, "conflicts")]).toEqual([6, 2, 4, 0]);
    const flask = rows[0];
    expect(matchesQuery(rec(s), flask, "  S/S BOTTLE ")).toBe(true);
    expect(matchesQuery(rec(s), flask, "p01")).toBe(true);
    expect(matchesQuery(rec(s), flask, "tumbler")).toBe(false);
    expect(matchesQuery(rec(s), flask, "")).toBe(true);
    expect(rows.map(statusTone)).toEqual(["success", "muted", "success", "muted", "muted", "muted"]);
  });
});
