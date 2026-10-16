// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationState } from "../domain/reconcile";
import { SOURCE_A, SOURCE_B } from "../workflow/testkit";
import { useAccordWorkflow } from "../workflow/useAccordWorkflow";
import { csvFile, mount, settle, stubObjectUrls } from "./testkit";
import { ARTIFACTS, createArtifactUrls, useExportArtifacts } from "./useExportArtifacts";

const META = { appVersion: "test", generatedAt: "2026-10-15T00:00:00.000Z", runId: "run-1" };

type Probe = { workflow: ReturnType<typeof useAccordWorkflow>; exp: ReturnType<typeof useExportArtifacts> };
let unmount = () => {};
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

// The real workflow hook feeding the export hook, as ExportScreen wires them.
async function setup(override?: (rec: ReconciliationState) => ReconciliationState) {
  const h = { current: null as unknown as Probe };
  function Probe() {
    const workflow = useAccordWorkflow();
    const rec = workflow.state.reconciliation;
    const exp = useExportArtifacts(rec && override ? override(rec) : rec);
    h.current = { workflow, exp };
    return null;
  }
  const m = mount(<Probe />);
  unmount = m.unmount;
  await act(() => h.current.workflow.chooseFile("A", csvFile("a.csv", SOURCE_A)));
  await act(() => h.current.workflow.chooseFile("B", csvFile("b.csv", SOURCE_B)));
  act(() => {
    for (const side of ["A", "B"] as const)
      for (const [field, columnId] of [["productId", "c0"], ["name", "c1"], ["quantity", "c2"]] as const)
        h.current.workflow.dispatch({ type: "draft/fieldMapped", side, field, columnId });
    h.current.workflow.dispatch({ type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: true });
  });
  await act(async () => {
    await h.current.workflow.confirmMappings();
  });
  return h;
}

const rec = (h: { current: Probe }) => h.current.workflow.state.reconciliation!;

function prepared(h: { current: Probe }) {
  act(() => {
    expect(h.current.exp.prepare(META)).toEqual({ ok: true });
  });
  return h.current.exp.artifacts!;
}

describe("useExportArtifacts", () => {
  it("creates three typed URLs from one snapshot, and replaces them on the next prepare", async () => {
    const urls = stubObjectUrls();
    const h = await setup();
    const first = prepared(h);
    expect(Object.keys(first.urls)).toEqual(["matches.csv", "unresolved.csv", "audit.json"]);
    const blobs = Object.values(first.urls).map((u) => urls.live.get(u)!);
    expect(blobs.map((b) => b.type)).toEqual(ARTIFACTS.map((a) => a.type));
    expect(await Promise.all(blobs.map((b) => b.text()))).toEqual(ARTIFACTS.map((a) => first.snapshot.files[a.name]));

    const second = prepared(h);
    expect(urls.revoked.sort()).toEqual(Object.values(first.urls).sort());
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(h.current.exp.isStillCurrent()).toBe(true);
  });

  it.each([
    ["a decision", (h: { current: Probe }) => act(() => void h.current.workflow.decide("exclude_exact", rec(h).acceptedPairs[0].leftId, rec(h).acceptedPairs[0].rightId))],
    ["a source replacement", async (h: { current: Probe }) => act(() => h.current.workflow.chooseFile("B", csvFile("b2.csv", SOURCE_B)))],
    [
      "a configuration change",
      async (h: { current: Probe }) => {
        act(() => h.current.workflow.dispatch({ type: "draft/optionSet", option: "idCaseSensitive", value: false }));
        await act(async () => {
          await h.current.workflow.confirmMappings();
        });
      },
    ],
    ["a reset", (h: { current: Probe }) => act(() => h.current.workflow.dispatch({ type: "workflow/reset" }))],
  ])("invalidates and revokes on %s", async (_, change) => {
    const urls = stubObjectUrls();
    const h = await setup();
    const a = prepared(h);
    await change(h);
    await settle();
    expect(h.current.exp.artifacts).toBeNull();
    expect(h.current.exp.isStillCurrent()).toBe(false);
    expect(urls.revoked.sort()).toEqual(Object.values(a.urls).sort());
  });

  it("treats a reconfirmed reload of the same file as a new session", async () => {
    stubObjectUrls();
    const h = await setup();
    prepared(h);
    const before = rec(h);
    await act(() => h.current.workflow.chooseFile("A", csvFile("a.csv", SOURCE_A)));
    act(() => {
      for (const [field, columnId] of [["productId", "c0"], ["name", "c1"], ["quantity", "c2"]] as const)
        h.current.workflow.dispatch({ type: "draft/fieldMapped", side: "A", field, columnId });
    });
    await act(async () => {
      await h.current.workflow.confirmMappings();
    });
    // Same hash and revision as the snapshot, but a different session.
    expect(rec(h).context.configurationHash).toBe(before.context.configurationHash);
    expect(rec(h).revision).toBe(before.revision);
    expect(h.current.exp.artifacts).toBeNull();
  });

  it("revokes the URLs on unmount", async () => {
    const urls = stubObjectUrls();
    const h = await setup();
    const a = prepared(h);
    unmount();
    unmount = () => {};
    expect(urls.revoked.sort()).toEqual(Object.values(a.urls).sort());
  });

  it("produces nothing when invariants fail", async () => {
    const urls = stubObjectUrls();
    const h = await setup((r) => ({ ...r, acceptedPairs: [...r.acceptedPairs, { ...r.acceptedPairs[0], id: "dup" }] }));
    act(() => {
      const r = h.current.exp.prepare(META);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.violations?.length).toBeGreaterThan(0);
    });
    expect(h.current.exp.artifacts).toBeNull();
    expect(urls.api.createObjectURL).not.toHaveBeenCalled();
  });

  it("exports after a cancelled run, listing unanalyzed records as unresolved", async () => {
    stubObjectUrls();
    const h = await setup();
    act(() => h.current.workflow.dispatch({ type: "analysis/started" }));
    const r = rec(h);
    act(() => h.current.workflow.dispatch({ type: "analysis/cancelled", generation: r.generation, configurationHash: r.context.configurationHash }));
    const a = prepared(h);
    expect(a.snapshot.audit.analysis.status).toBe("cancelled");
    expect(a.snapshot.unresolved.map((u) => u.reason_code)).toContain("analysis_cancelled");
  });
});

describe("createArtifactUrls", () => {
  it("revokes what it already created when a later URL fails", async () => {
    stubObjectUrls();
    const { snapshot } = prepared(await setup());
    let n = 0;
    const revoked: string[] = [];
    const api = {
      createObjectURL: () => {
        if (++n === 3) throw new Error("quota");
        return `blob:${n}`;
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    };
    expect(createArtifactUrls(snapshot, api)).toBeNull();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });
});
