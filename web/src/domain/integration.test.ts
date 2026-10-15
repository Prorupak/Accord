// Spec §13.1 / §15 canonical fixture, end to end through the real domain pipeline with no model.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replayAudit } from "./auditReplay";
import { candidatesFor, eligibleRightRows } from "./candidates";
import { buildContext } from "./eligibility";
import { prepareExport, type AuditV1 } from "./exportSnapshot";
import { configurationHash, validateConfiguration } from "./mapping";
import { parseDataset } from "./parseCsv";
import { applyDecision, initializeState, partition, unresolvedReason } from "./reconcile";
import type { Dataset } from "./types";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../fixtures/inventory/${name}`, import.meta.url))));

async function load(side: "A" | "B", name: string): Promise<Dataset> {
  const r = await parseDataset(side, name, fixture(name));
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe("canonical inventory fixture", () => {
  it("reconciles to 3 pairs, 1 unresolved A, 2 unresolved B, with P03 delta -1, and replays exactly", async () => {
    // 1–2. Load original bytes, parse and validate.
    const datasets = { A: await load("A", "source-a.csv"), B: await load("B", "source-b.csv") };
    expect(datasets.A.rows).toHaveLength(4);
    expect(datasets.B.rows).toHaveLength(5);

    // 3. Confirm mappings; the user asserts comparable quantity units.
    const config = validateConfiguration(datasets, {
      A: { productId: "c0", name: "c1", quantity: "c2", unit: null },
      B: { productId: "c0", name: "c1", quantity: "c2", unit: null },
      idCaseSensitive: true,
      sharedQuantityUnitConfirmed: true,
    });
    if (!config.ok) throw new Error("mapping");
    const hash = await configurationHash({ A: datasets.A.id, B: datasets.B.id }, config.value);
    const ctx = buildContext(datasets, config.value, hash);
    const [a, b] = [datasets.A.rows, datasets.B.rows].map((rows) => rows.map((r) => r.id));

    // 4. Exact-ID pairs: P01 and P03 only.
    let state = initializeState(ctx);
    expect(state.acceptedPairs.map((p) => [p.leftId, p.rightId, p.method])).toEqual([
      [a[0], b[0], "exact_id"],
      [a[2], b[2], "exact_id"],
    ]);

    // 5. Semantic candidates. Tote retrieves the bag; the travel cup retrieves both tumblers
    //    with equal scores, ordered by Source B index. Nothing is paired by retrieval.
    expect(candidatesFor(state, a[1]).map((c) => c.rightId)).toEqual([b[1]]);
    const cup = candidatesFor(state, a[3]);
    expect(cup.map((c) => c.rightId)).toEqual([b[3], b[4]]);
    expect(cup[0].score).toBe(cup[1].score);
    expect(eligibleRightRows(state, a[1])).toEqual([b[1], b[3], b[4]]);
    expect(partition(state).unmatchedA).toEqual([a[1], a[3]]);

    // 6. Explicit human-approved tote/bag decision (manual; no fabricated model proposal).
    const accepted = applyDecision(state, {
      id: "user-accept-tote",
      action: "accept",
      leftId: a[1],
      rightId: b[1],
      proposalId: null,
      configurationHash: hash,
      at: "2026-10-15T10:00:00.000Z",
    });
    expect(accepted.ok).toBe(true);
    state = accepted.state;

    // 7. The travel cup stays unresolved and is not paired with either capacity.
    expect(partition(state).unmatchedA).toEqual([a[3]]);
    expect(partition(state).unmatchedB).toEqual([b[3], b[4]]);
    expect(unresolvedReason(state, a[3]).reason).toBe("unpaired");

    // 8–9. Freeze and export all three artifacts.
    const exported = prepareExport(state, { appVersion: "0.1.0", generatedAt: "2026-10-15T10:01:00.000Z", runId: "fixture" });
    if (!exported.ok) throw new Error(JSON.stringify(exported.violations));
    const snap = exported.snapshot;
    expect(Object.keys(snap.files)).toEqual(["matches.csv", "unresolved.csv", "audit.json"]);

    expect(snap.matches.map((m) => [m.left_product_id, m.right_product_id, m.match_method, m.quantity_status, m.delta_b_minus_a])).toEqual([
      ["P01", "P01", "exact_id", "equal", "0"],
      ["", "", "manual", "equal", "0"],
      ["P03", "P03", "exact_id", "different", "-1"],
    ]);
    expect(snap.matches[1].decision_id).toBe("user-accept-tote");
    expect(snap.unresolved.map((u) => [u.source, u.name])).toEqual([
      ["A", "Travel cup blue"],
      ["B", "Travel tumbler blue 350ml"],
      ["B", "Travel tumbler blue 500ml"],
    ]);

    const audit = JSON.parse(snap.files["audit.json"]) as AuditV1;
    expect(audit.invariants).toEqual({ passed: true, leftCount: 4, rightCount: 5, pairCount: 3 });
    expect(audit.datasets.map((d) => d.id)).toEqual([datasets.A.id, datasets.B.id]);
    expect(audit.decisions).toHaveLength(1);
    expect(audit.proposals).toEqual([]);
    expect(audit.modelRuns).toEqual([]);

    // 10–11. Replay from the serialized audit alone and compare byte-for-byte.
    const replay = await replayAudit(audit);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.files["matches.csv"]).toBe(snap.files["matches.csv"]);
    expect(replay.value.files["unresolved.csv"]).toBe(snap.files["unresolved.csv"]);
    expect(replay.value.matches).toEqual(snap.matches);
  });
});
