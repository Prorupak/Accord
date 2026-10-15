import { describe, expect, it } from "vitest";
import { candidatesFor } from "./candidates";
import { checkInvariants } from "./invariants";
import { addProposals, applyDecision, partition, type ReconciliationState } from "./reconcile";
import { decision, rowA, rowB, setup } from "./testkit";
import type { DecisionAction, Pair } from "./types";

const codes = (s: ReconciliationState) => {
  const r = checkInvariants(s);
  return r.ok ? [] : r.violations.map((x) => x.code);
};

describe("checkInvariants", () => {
  const base = () => setup("id,name,qty\nP1,mug,1\n,tote,2\n,cup,3\n", "id,name,qty\nP1,mug,1\n,tote bag,2\n");

  it("passes for valid state and reports counts from source rows", async () => {
    const s = await base();
    expect(checkInvariants(s)).toEqual({ ok: true, counts: { leftCount: 3, rightCount: 2, pairCount: 1 } });
  });

  it("catches a semantic pair injected without a decision", async () => {
    const s = await base();
    const forged: Pair = { id: "decision:x", leftId: rowA(s, 1), rightId: rowB(s, 1), configurationHash: s.context.configurationHash, method: "manual", decisionId: "x", proposalId: null };
    expect(codes({ ...s, acceptedPairs: [...s.acceptedPairs, forged] })).toEqual(["missing_decision"]);
  });

  it("catches an AI pair whose proposal does not exist", async () => {
    const s0 = await base();
    const d = decision(s0, "accept", rowA(s0, 1), rowB(s0, 1));
    const s = applyDecision(s0, d).state;
    const forged = s.acceptedPairs.map((p) => (p.method === "manual" ? { ...p, method: "ai_reviewed" as const, proposalId: "ghost" } : p));
    expect(codes({ ...s, acceptedPairs: forged })).toContain("missing_decision");
  });

  it("catches an accepted pair whose decision was later undone", async () => {
    const s0 = await base();
    const s1 = applyDecision(s0, decision(s0, "accept", rowA(s0, 1), rowB(s0, 1))).state;
    const s2 = applyDecision(s1, decision(s1, "undo", rowA(s0, 1), rowB(s0, 1))).state;
    expect(codes({ ...s2, acceptedPairs: s1.acceptedPairs })).toEqual(["missing_decision"]);
  });

  it("catches row reuse, stale hashes, duplicate pair IDs and nonexistent rows", async () => {
    const s = await base();
    const exact = s.acceptedPairs[0];
    expect(codes({ ...s, acceptedPairs: [exact, exact] })).toEqual(expect.arrayContaining(["duplicate_pair_id", "row_reused", "conservation"]));
    expect(codes({ ...s, acceptedPairs: [{ ...exact, configurationHash: "old" }] })).toEqual(["stale_pair"]);
    expect(codes({ ...s, acceptedPairs: [{ ...exact, rightId: "B:nope:0" }] })).toEqual(expect.arrayContaining(["ineligible_pair"]));
    expect(codes({ ...s, rejectedPairs: [{ leftId: "A:x:0", rightId: rowB(s, 0) }] })).toEqual(["unknown_ledger_row"]);
  });

  it("catches an exact pair that the user excluded or that lacks a shared ID", async () => {
    const s = await base();
    const exact = s.acceptedPairs[0];
    expect(codes({ ...s, excludedExactPairs: [{ leftId: exact.leftId, rightId: exact.rightId }] })).toEqual(["ineligible_pair"]);
    const fake: Pair = { ...exact, id: `exact:${rowA(s, 1)}:${rowB(s, 1)}`, leftId: rowA(s, 1), rightId: rowB(s, 1) };
    expect(codes({ ...s, acceptedPairs: [exact, fake] })).toEqual(["ineligible_pair"]);
  });
});

// Seeded PRNG so failures reproduce.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: random decision sequences preserve invariants", () => {
  const WORDS = ["mug", "cup", "blue", "red", "steel", "tote", "bag", "large", ""];
  const IDS = ["", "", "", "P1", "P2", "P3", "p1"];

  async function randomState(rand: () => number) {
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const rows = (n: number) =>
      Array.from({ length: n }, () => `${pick(IDS)},${pick(WORDS)} ${pick(WORDS)},${Math.floor(rand() * 5)}`).join("\n");
    return setup(`id,name,qty\n${rows(1 + Math.floor(rand() * 8))}\n`, `id,name,qty\n${rows(1 + Math.floor(rand() * 8))}\n`, {
      idCaseSensitive: rand() < 0.5,
    });
  }

  it("keeps conservation, one-to-one and policy after every step across 200 seeded runs", async () => {
    const ACTIONS: DecisionAction[] = ["accept", "accept", "reject", "defer", "undo", "exclude_exact"];
    const effective = new Map<string, number>();
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      let s = await randomState(rand);
      expect(checkInvariants(s).ok, `seed ${seed} initial`).toBe(true);

      // Some model proposals over retrieved candidates, so ai_reviewed paths are exercised.
      const proposals = s.context.datasets.A.rows.flatMap((r) => {
        const c = candidatesFor(s, r.id)[0];
        if (!c) return [];
        const name = (id: string) => s.context.rows.get(id)!.name;
        return [{
          leftId: r.id,
          rightId: c.rightId,
          outcome: "suggest" as const,
          reasonCode: "semantic_equivalence" as const,
          evidence: [
            { side: "A" as const, rowId: r.id, columnId: "c1", value: name(r.id) },
            { side: "B" as const, rowId: c.rightId, columnId: "c1", value: name(c.rightId) },
          ],
          explanation: "",
        }];
      });
      s = addProposals(s, { requestId: `r${seed}`, generation: s.generation, configurationHash: s.context.configurationHash, proposals }).state;

      for (let step = 0; step < 25; step++) {
        const left = pick(s.context.datasets.A.rows).id;
        const right = pick(s.context.datasets.B.rows).id;
        const action = pick(ACTIONS);
        const proposal = action === "accept" && rand() < 0.5 ? s.proposals.find((p) => p.leftId === left) : undefined;
        const d = decision(s, action, left, proposal?.rightId ?? right, { proposalId: proposal?.id ?? null });
        const before = s;
        const r = applyDecision(s, d);
        if (!r.ok) expect(r.state, `seed ${seed} step ${step}: failed decision must not change state`).toBe(before);
        s = r.state;
        if (r.ok && r.changed) {
          const kind = d.action === "accept" && d.proposalId ? "accept_ai" : d.action;
          effective.set(kind, (effective.get(kind) ?? 0) + 1);
        }
        const report = checkInvariants(s);
        expect(report.ok, `seed ${seed} step ${step}: ${JSON.stringify(report)}`).toBe(true);
        const { pairs, unmatchedA, unmatchedB } = partition(s);
        expect(s.context.datasets.A.rows.length).toBe(pairs.length + unmatchedA.length);
        expect(s.context.datasets.B.rows.length).toBe(pairs.length + unmatchedB.length);
        // Replaying the same decision is always a no-op.
        if (r.ok) expect(applyDecision(s, d)).toMatchObject({ ok: true, changed: false });
      }
    }
    // Guard against a vacuous property: every kind of effective transition actually happened.
    for (const kind of ["accept", "accept_ai", "reject", "defer", "undo", "exclude_exact"])
      expect(effective.get(kind) ?? 0, kind).toBeGreaterThan(5);
  });
});
