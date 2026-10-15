import { describe, expect, it } from "vitest";
import { checkPair } from "./eligibility";
import {
  addProposals,
  applyDecision,
  nextGeneration,
  partition,
  pendingProposals,
  proposalStatus,
  recordAnalysis,
  unresolvedReason,
  type IncomingProposal,
  type ReconciliationState,
} from "./reconcile";
import { decision, rowA, rowB, setup } from "./testkit";

const ok = (r: ReturnType<typeof applyDecision>) => {
  if (!r.ok) throw new Error(`decision failed: ${r.error.code}`);
  return r.state;
};

const methods = (s: ReconciliationState) => s.acceptedPairs.map((p) => `${p.method}:${p.leftId}>${p.rightId}`);

describe("exact-ID matching", () => {
  it("does not treat 0012 and 12 as the same ID", async () => {
    const s = await setup("id,name,qty\n0012,mug,1\n", "id,name,qty\n12,mug,1\n");
    expect(s.acceptedPairs).toEqual([]);
    expect(checkPair(s.context, s, rowA(s, 0), rowB(s, 0), "semantic")).toMatchObject({ ok: false, reason: "conflicting_id" });
  });

  it("matches abc and ABC only under the explicit case-insensitive policy", async () => {
    const csvA = "id,name,qty\nabc,mug,1\n";
    const csvB = "id,name,qty\nABC,mug,1\n";
    expect((await setup(csvA, csvB)).acceptedPairs).toHaveLength(0);
    expect((await setup(csvA, csvB, { idCaseSensitive: false })).acceptedPairs).toHaveLength(1);
  });

  it("trims surrounding whitespace but keeps punctuation", async () => {
    expect((await setup("id,name,qty\n  P-01 ,a,1\n", "id,name,qty\nP-01,b,1\n")).acceptedPairs).toHaveLength(1);
    expect((await setup("id,name,qty\nP-01,a,1\n", "id,name,qty\nP01,b,1\n")).acceptedPairs).toHaveLength(0);
  });

  it("pairs unique identical IDs even when names differ, quantities differ or a name is empty", async () => {
    const s = await setup("id,name,qty\nP1,Mug,6\nP2,,1\n", "id,name,qty\nP1,Totally different,5\nP2,Thing,1\n");
    expect(s.acceptedPairs.map((p) => p.method)).toEqual(["exact_id", "exact_id"]);
  });

  it.each([
    ["Source A", "id,name,qty\nD,a,1\nD,b,1\nU,c,1\n", "id,name,qty\nD,a,1\nU,c,1\n"],
    ["Source B", "id,name,qty\nD,a,1\nU,c,1\n", "id,name,qty\nD,a,1\nD,b,1\nU,c,1\n"],
    ["both sources", "id,name,qty\nD,a,1\nD,b,1\nU,c,1\n", "id,name,qty\nD,a,1\nD,b,1\nU,c,1\n"],
  ])("quarantines every row carrying an ID duplicated in %s, on both sides", async (_l, a, b) => {
    const s = await setup(a, b);
    const dRows = [...s.context.rows.values()].filter((r) => r.normalizedId === "D").map((r) => r.row.id);
    expect(dRows.every((id) => s.context.quarantined.has(id))).toBe(true);
    expect(s.acceptedPairs.map((p) => p.leftId)).toEqual([[...s.context.rows.values()].find((r) => r.side === "A" && r.normalizedId === "U")!.row.id]);
    for (const id of dRows.filter((id) => id.startsWith("A:")))
      expect(unresolvedReason(s, id).reason).toBe("duplicate_id");
  });

  it("blocks manual pairing of a quarantined row, including with an ID-less row", async () => {
    const s = await setup("id,name,qty\nD,mug,1\nD,mug,1\n", "id,name,qty\n,mug,1\n");
    const r = applyDecision(s, decision(s, "accept", rowA(s, 0), rowB(s, 0)));
    expect(r).toMatchObject({ ok: false, error: { code: "duplicate_id" } });
    expect(r.state).toBe(s);
  });

  it("does nothing with ID-based logic when no product-ID column is mapped", async () => {
    const s = await setup("id,name,qty\nP1,mug,1\n", "id,name,qty\nP1,mug,1\n", {
      B: { productId: null, name: "c1", quantity: "c2", unit: null },
    });
    expect(s.acceptedPairs).toEqual([]);
    expect(checkPair(s.context, s, rowA(s, 0), rowB(s, 0), "semantic").ok).toBe(true);
  });
});

describe("decisions", () => {
  const fixture = () =>
    setup(
      "id,name,qty\nP1,flask,12\n,cotton tote,8\n,travel cup,4\n,,3\n",
      "id,name,qty\nP1,bottle,12\n,cotton bag,8\n,travel tumbler 350,4\n,travel tumbler 500,4\nQ9,travel cup,4\n",
    );

  it("accepts a manual pair only through an explicit decision and records method and decision ID", async () => {
    const s = await fixture();
    expect(methods(s)).toHaveLength(1);
    const d = decision(s, "accept", rowA(s, 1), rowB(s, 1));
    const next = ok(applyDecision(s, d));
    expect(next.acceptedPairs[1]).toEqual({
      id: `decision:${d.id}`,
      leftId: rowA(s, 1),
      rightId: rowB(s, 1),
      configurationHash: s.context.configurationHash,
      method: "manual",
      decisionId: d.id,
      proposalId: null,
    });
    expect(next.revision).toBe(s.revision + 1);
    expect(s.acceptedPairs).toHaveLength(1); // previous state untouched
  });

  it("rejects pairs with different nonempty IDs, even with identical names", async () => {
    const s = await fixture();
    const r = applyDecision(s, decision(s, "accept", rowA(s, 0), rowB(s, 4)));
    expect(r).toMatchObject({ ok: false, error: { code: "conflicting_id" } });
  });

  it("enforces one-to-one: the second acceptance of a B row fails and leaves state unchanged", async () => {
    const s = await fixture();
    const s1 = ok(applyDecision(s, decision(s, "accept", rowA(s, 2), rowB(s, 2))));
    const r = applyDecision(s1, decision(s1, "accept", rowA(s1, 1), rowB(s1, 2)));
    expect(r).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(r.state).toBe(s1);
  });

  it("treats a repeated decision ID as one effect (double click)", async () => {
    const s = await fixture();
    const d = decision(s, "accept", rowA(s, 1), rowB(s, 1));
    const s1 = ok(applyDecision(s, d));
    const again = applyDecision(s1, { ...d, at: "2026-10-15T00:00:01.000Z" });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(again.state).toBe(s1);
    expect(applyDecision(s1, { ...d, action: "reject" })).toMatchObject({ ok: false, error: { code: "decision_id_conflict" } });
  });

  it("rejects decisions made against a stale configuration", async () => {
    const s = await fixture();
    const r = applyDecision(s, decision(s, "accept", rowA(s, 1), rowB(s, 1), { configurationHash: "old" }));
    expect(r).toMatchObject({ ok: false, error: { code: "stale_configuration" } });
  });

  it("rejects nameless rows for manual pairing", async () => {
    const s = await fixture();
    expect(applyDecision(s, decision(s, "accept", rowA(s, 3), rowB(s, 1)))).toMatchObject({ ok: false, error: { code: "missing_name" } });
    expect(unresolvedReason(s, rowA(s, 3)).reason).toBe("missing_name");
  });

  it("rejects unknown rows and swapped sides", async () => {
    const s = await fixture();
    expect(applyDecision(s, decision(s, "accept", "A:x:0", rowB(s, 1)))).toMatchObject({ error: { code: "unknown_row" } });
    expect(applyDecision(s, decision(s, "accept", rowB(s, 1), rowA(s, 1)))).toMatchObject({ error: { code: "wrong_side" } });
  });

  it("records a rejection as a configuration-scoped exclusion without removing either row", async () => {
    const s = await fixture();
    const s1 = ok(applyDecision(s, decision(s, "reject", rowA(s, 1), rowB(s, 1))));
    expect(s1.rejectedPairs).toEqual([{ leftId: rowA(s, 1), rightId: rowB(s, 1) }]);
    expect(partition(s1).unmatchedA).toContain(rowA(s, 1));
    expect(partition(s1).unmatchedB).toContain(rowB(s, 1));
    expect(applyDecision(s1, decision(s1, "accept", rowA(s, 1), rowB(s, 1)))).toMatchObject({ error: { code: "rejected_pair" } });
    expect(unresolvedReason(s1, rowA(s, 1)).reason).toBe("rejected");
    const s2 = ok(applyDecision(s1, decision(s1, "undo", rowA(s, 1), rowB(s, 1))));
    expect(s2.rejectedPairs).toEqual([]);
    expect(ok(applyDecision(s2, decision(s2, "accept", rowA(s, 1), rowB(s, 1)))).acceptedPairs).toHaveLength(2);
  });

  it("defers without removing a row, and a later decision supersedes it", async () => {
    const s = await fixture();
    const s1 = ok(applyDecision(s, decision(s, "defer", rowA(s, 2), null)));
    expect(unresolvedReason(s1, rowA(s, 2)).reason).toBe("deferred");
    expect(partition(s1).unmatchedA).toContain(rowA(s, 2));
    const s2 = ok(applyDecision(s1, decision(s1, "accept", rowA(s, 2), rowB(s, 2))));
    expect(partition(s2).unmatchedA).not.toContain(rowA(s, 2));
  });

  it("undoes an acceptance, making both rows available again, without any model call", async () => {
    const s = await fixture();
    const s1 = ok(applyDecision(s, decision(s, "accept", rowA(s, 2), rowB(s, 2))));
    const s2 = ok(applyDecision(s1, decision(s1, "undo", rowA(s, 2), rowB(s, 2))));
    expect(s2.acceptedPairs).toEqual(s.acceptedPairs);
    expect(s2.proposals).toEqual(s.proposals);
    expect(ok(applyDecision(s2, decision(s2, "accept", rowA(s, 1), rowB(s, 2)))).acceptedPairs).toHaveLength(2);
    expect(applyDecision(s2, decision(s2, "undo", rowA(s, 2), rowB(s, 2)))).toMatchObject({ error: { code: "nothing_to_undo" } });
  });

  it("excludes an exact pair persistently and restores it only by undo", async () => {
    const s = await fixture();
    const [a, b] = [rowA(s, 0), rowB(s, 0)];
    expect(applyDecision(s, decision(s, "exclude_exact", rowA(s, 1), rowB(s, 1)))).toMatchObject({ error: { code: "not_exact_pair" } });
    const s1 = ok(applyDecision(s, decision(s, "exclude_exact", a, b)));
    expect(s1.acceptedPairs).toEqual([]);
    expect(s1.excludedExactPairs).toEqual([{ leftId: a, rightId: b }]);
    expect(unresolvedReason(s1, a).reason).toBe("rejected");
    expect(unresolvedReason(s1, b).reason).toBe("rejected");
    // Not reinstated by manual acceptance or a later proposal batch.
    expect(applyDecision(s1, decision(s1, "accept", a, b))).toMatchObject({ error: { code: "excluded_exact_pair" } });
    const intake = addProposals(s1, batch(s1, [suggest(a, b, s1)]));
    expect(intake.state.acceptedPairs).toEqual([]);
    expect(proposalStatus(intake.state, intake.state.proposals[0])).toBe("unavailable");
    const s2 = ok(applyDecision(s1, decision(s1, "undo", a, b)));
    expect(s2.acceptedPairs).toEqual(s.acceptedPairs);
  });

  it("cannot restore an excluded exact pair after a row was used elsewhere", async () => {
    const s = await setup("id,name,qty\nP1,mug,1\n", "id,name,qty\nP1,mug,1\n,mug,1\n");
    const s1 = ok(applyDecision(s, decision(s, "exclude_exact", rowA(s, 0), rowB(s, 0))));
    const s2 = ok(applyDecision(s1, decision(s1, "accept", rowA(s, 0), rowB(s, 1))));
    expect(applyDecision(s2, decision(s2, "undo", rowA(s, 0), rowB(s, 0)))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

const ev = (s: ReconciliationState, side: "A" | "B", rowId: string) => {
  const info = s.context.rows.get(rowId)!;
  return { side, rowId, columnId: "c1", value: info.name };
};

function suggest(leftId: string, rightId: string, s: ReconciliationState): IncomingProposal {
  return {
    leftId,
    rightId,
    outcome: "suggest",
    reasonCode: "semantic_equivalence",
    evidence: [ev(s, "A", leftId), ev(s, "B", rightId)],
    explanation: "Same product.",
  };
}

const batch = (s: ReconciliationState, proposals: IncomingProposal[], requestId = "r1") => ({
  requestId,
  generation: s.generation,
  configurationHash: s.context.configurationHash,
  proposals,
});

describe("proposals", () => {
  const fixture = () =>
    setup("id,name,qty\n,blue mug,1\n,blue mug large,1\n,travel cup,1\n", "id,name,qty\n,blue mug,1\n,travel tumbler 350,1\n,travel tumbler 500,1\n");

  it("lets two proposals share a B row; the first accepted wins and the second becomes unavailable", async () => {
    const s = await fixture();
    const s1 = addProposals(s, batch(s, [suggest(rowA(s, 0), rowB(s, 0), s), suggest(rowA(s, 1), rowB(s, 0), s)])).state;
    expect(pendingProposals(s1)).toHaveLength(2);
    const [p0, p1] = s1.proposals;
    const s2 = ok(applyDecision(s1, decision(s1, "accept", p0.leftId, p0.rightId, { proposalId: p0.id })));
    expect(s2.acceptedPairs[0]).toMatchObject({ method: "ai_reviewed", proposalId: p0.id });
    expect(proposalStatus(s2, p0)).toBe("accepted");
    expect(proposalStatus(s2, p1)).toBe("unavailable");
    expect(pendingProposals(s2)).toEqual([]);
    expect(applyDecision(s2, decision(s2, "accept", p1.leftId, p1.rightId, { proposalId: p1.id }))).toMatchObject({ error: { code: "unavailable" } });
  });

  it("never turns a proposal into a pair without a human decision", async () => {
    const s = await fixture();
    const s1 = addProposals(s, batch(s, [suggest(rowA(s, 0), rowB(s, 0), s)])).state;
    expect(s1.acceptedPairs).toEqual([]);
    expect(partition(s1).unmatchedA).toHaveLength(3);
    expect(unresolvedReason(s1, rowA(s, 0))).toEqual({ reason: "unpaired", detail: "Suggested pair awaiting review." });
  });

  it("requires accept-by-proposal to cite the proposal's own rows", async () => {
    const s = await fixture();
    const s1 = addProposals(s, batch(s, [suggest(rowA(s, 0), rowB(s, 0), s)])).state;
    const p = s1.proposals[0];
    expect(applyDecision(s1, decision(s1, "accept", rowA(s, 1), rowB(s, 0), { proposalId: p.id }))).toMatchObject({ error: { code: "proposal_mismatch" } });
    expect(applyDecision(s1, decision(s1, "accept", rowA(s, 0), rowB(s, 0), { proposalId: "nope" }))).toMatchObject({ error: { code: "unknown_proposal" } });
  });

  it("drops a batch from an old generation or configuration entirely", async () => {
    const s = await fixture();
    const later = nextGeneration(s);
    const late = addProposals(later, batch(s, [suggest(rowA(s, 0), rowB(s, 0), s)]));
    expect(late).toMatchObject({ stale: true, added: 0 });
    expect(late.state).toBe(later);
    const wrongHash = addProposals(s, { ...batch(s, [suggest(rowA(s, 0), rowB(s, 0), s)]), configurationHash: "x" });
    expect(wrongHash.stale).toBe(true);
    expect(recordAnalysis(later, s.generation, s.context.configurationHash, { ...s.analysis, status: "complete" })).toBe(later);
  });

  it("drops invented rows, conflicting targets, duplicates and altered or one-sided evidence", async () => {
    const s = await fixture();
    const good = suggest(rowA(s, 0), rowB(s, 0), s);
    const r = addProposals(s, batch(s, [
      good,
      { ...good, leftId: "A:invented:9" },
      { ...good }, // duplicate result for the same row
      { ...suggest(rowA(s, 1), rowB(s, 0), s), evidence: [ev(s, "A", rowA(s, 1)), { ...ev(s, "B", rowB(s, 0)), value: "BLUE MUG" }] },
      { ...suggest(rowA(s, 2), rowB(s, 1), s), evidence: [ev(s, "A", rowA(s, 2))] },
    ]));
    expect(r.added).toBe(1);
    expect(r.dropped.map((d) => d.reason)).toEqual(["unknown_row", "duplicate_result", "invalid_evidence", "invalid_evidence"]);
  });

  it("keeps abstentions honest: ambiguous abstention becomes the row's reason", async () => {
    const s = await fixture();
    const abstain: IncomingProposal = {
      leftId: rowA(s, 2),
      rightId: null,
      outcome: "abstain",
      reasonCode: "ambiguous",
      evidence: [],
      explanation: "Both capacities plausible.",
    };
    const s1 = addProposals(s, batch(s, [abstain])).state;
    expect(unresolvedReason(s1, rowA(s, 2)).reason).toBe("ambiguous");
    expect(addProposals(s, batch(s, [{ ...abstain, rightId: rowB(s, 1) }])).dropped[0].reason).toBe("invalid_target");
  });

  it("replaces pending proposals on re-run but keeps any that a decision references", async () => {
    const s = await fixture();
    const s1 = addProposals(s, batch(s, [suggest(rowA(s, 0), rowB(s, 0), s), suggest(rowA(s, 1), rowB(s, 0), s)], "r1")).state;
    const s2 = ok(applyDecision(s1, decision(s1, "reject", rowA(s, 1), rowB(s, 0), { proposalId: s1.proposals[1].id })));
    const s3 = addProposals(s2, batch(s2, [suggest(rowA(s, 0), rowB(s, 0), s), suggest(rowA(s, 1), rowB(s, 0), s)], "r2")).state;
    expect(s3.proposals.map((p) => p.id).sort()).toEqual([`r1:${rowA(s, 1)}`, `r2:${rowA(s, 0)}`, `r2:${rowA(s, 1)}`].sort());
    expect(proposalStatus(s3, s3.proposals.find((p) => p.id === `r2:${rowA(s, 1)}`)!)).toBe("rejected");
  });
});

describe("unresolved reasons", () => {
  it("separates no_candidates (zero overlap) from conflicting_id and analysis outcomes", async () => {
    const s = await setup("id,name,qty\n,sofa,1\nP1,blue mug,1\n,red lamp,1\n,green lamp,1\n", "id,name,qty\nQ1,blue mug,1\n,lamp,1\n");
    expect(unresolvedReason(s, rowA(s, 0)).reason).toBe("no_candidates");
    expect(unresolvedReason(s, rowA(s, 1)).reason).toBe("conflicting_id");
    expect(unresolvedReason(s, rowA(s, 2)).reason).toBe("unpaired");

    const ran = recordAnalysis(s, s.generation, s.context.configurationHash, {
      status: "cancelled",
      selectedRowIds: [rowA(s, 2)],
      analyzedRowIds: [],
      failedRowIds: [],
    });
    expect(unresolvedReason(ran, rowA(s, 2)).reason).toBe("analysis_cancelled");
    expect(unresolvedReason(ran, rowA(s, 3)).reason).toBe("analysis_limit");
    const failed = recordAnalysis(s, s.generation, s.context.configurationHash, {
      status: "partial",
      selectedRowIds: [rowA(s, 2)],
      analyzedRowIds: [],
      failedRowIds: [rowA(s, 2)],
    });
    expect(unresolvedReason(failed, rowA(s, 2)).reason).toBe("analysis_failed");
  });
});
