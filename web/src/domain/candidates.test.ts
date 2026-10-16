import { describe, expect, it } from "vitest";
import { candidatesFor, eligibleRightRows, jaccard, nameTokens, normalizeName } from "./candidates";
import { applyDecision } from "./reconcile";
import { decision, rowA, rowB, setup } from "./testkit";

describe("name normalization", () => {
  it("applies NFKC, case folding, punctuation-to-space and whitespace collapse", () => {
    expect(normalizeName("  ＳＳ／Bottle—750ml!! ")).toBe("ss bottle 750ml");
    expect(normalizeName("Straße")).toBe(normalizeName("STRASSE"));
  });

  it("tokenizes Unicode letters and numbers as a set", () => {
    expect([...nameTokens("Café crème, café 2")]).toEqual(["café", "crème", "2"]);
    expect(nameTokens("---").size).toBe(0);
  });

  it("scores token-set Jaccard similarity", () => {
    expect(jaccard(nameTokens("white ceramic mug"), nameTokens("Ceramic mug white"))).toBe(1);
    expect(jaccard(nameTokens("a b"), nameTokens("b c"))).toBeCloseTo(1 / 3);
    expect(jaccard(nameTokens(""), nameTokens(""))).toBe(0);
  });
});

describe("candidatesFor", () => {
  it("ranks by score and breaks ties by Source B record index", async () => {
    const s = await setup(
      "id,name,qty\n,blue cup,1\n",
      "id,name,qty\n,red cup,1\n,blue cup,1\n,green cup,1\n,cup,1\n",
    );
    const c = candidatesFor(s, rowA(s, 0));
    expect(c.map((x) => x.rightId)).toEqual([rowB(s, 1), rowB(s, 3), rowB(s, 0), rowB(s, 2)]);
    expect(c[1].score).toBe(0.5);
    expect(c[2].score).toBeCloseTo(1 / 3);
  });

  it("returns at most five positive-score candidates", async () => {
    const b = Array.from({ length: 8 }, (_, i) => `,mug ${i},1`).join("\n");
    const s = await setup("id,name,qty\n,mug,1\n", `id,name,qty\n${b}\n`);
    expect(candidatesFor(s, rowA(s, 0))).toHaveLength(5);
    expect(candidatesFor(s, rowA(s, 0)).map((c) => c.rightId)).toEqual([0, 1, 2, 3, 4].map((i) => rowB(s, i)));
  });

  it("ignores quantities: a large quantity difference does not lower rank", async () => {
    const s = await setup("id,name,qty\n,steel flask,10\n", "id,name,qty\n,steel flask,9999\n,steel flask tall,10\n");
    expect(candidatesFor(s, rowA(s, 0))[0].rightId).toBe(rowB(s, 0));
  });

  it("returns nothing for zero lexical overlap, but the manual picker still offers the row", async () => {
    const s = await setup("id,name,qty\n,sofa,1\n", "id,name,qty\n,couch,1\n");
    expect(candidatesFor(s, rowA(s, 0))).toEqual([]);
    expect(eligibleRightRows(s, rowA(s, 0))).toEqual([rowB(s, 0)]);
  });

  it("never offers conflicting-ID, quarantined, nameless, paired or rejected rows", async () => {
    const s0 = await setup(
      "id,name,qty\n,blue mug,1\nP9,blue mug,1\n",
      [
        "id,name,qty",
        "Q1,blue mug,1", // conflicting ID for the P9 row, eligible for the no-ID row
        "D1,blue mug,1", // duplicated ID → quarantined
        "D1,blue mug,1",
        ",,1", // no name
        ",blue mug,1", // will be paired
        ",blue mug,1", // will be rejected
        ",blue mug,1", // eligible
      ].join("\n"),
    );
    const accepted = applyDecision(s0, decision(s0, "accept", rowA(s0, 1), rowB(s0, 4)));
    expect(accepted.ok).toBe(true);
    const s1 = accepted.state;
    const s2 = applyDecision(s1, decision(s1, "reject", rowA(s1, 0), rowB(s1, 5))).state;
    expect(candidatesFor(s2, rowA(s2, 0)).map((c) => c.rightId)).toEqual([rowB(s2, 0), rowB(s2, 6)]);
    // The paired A row gets no candidates at all.
    expect(candidatesFor(s2, rowA(s2, 1))).toEqual([]);
  });

  it("allows two rows to share a candidate: suggestions reserve nothing", async () => {
    const s = await setup("id,name,qty\n,blue mug,1\n,blue mug large,1\n", "id,name,qty\n,blue mug,1\n");
    expect(candidatesFor(s, rowA(s, 0))[0].rightId).toBe(rowB(s, 0));
    expect(candidatesFor(s, rowA(s, 1))[0].rightId).toBe(rowB(s, 0));
  });

  it("ignores row IDs that do not exist or are on the wrong side", async () => {
    const s = await setup("id,name,qty\n,mug,1\n", "id,name,qty\n,mug,1\n");
    expect(candidatesFor(s, "A:nope:0")).toEqual([]);
    expect(candidatesFor(s, rowB(s, 0))).toEqual([]);
  });
});
