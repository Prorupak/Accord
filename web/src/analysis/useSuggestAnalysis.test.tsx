// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_A, SOURCE_B } from "../workflow/testkit";
import { useAccordWorkflow } from "../workflow/useAccordWorkflow";
import { fakeTransport, ids, ok } from "./testkit";
import { useSuggestAnalysis, type SuggestAnalysisOptions } from "./useSuggestAnalysis";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe = { workflow: ReturnType<typeof useAccordWorkflow>; analysis: ReturnType<typeof useSuggestAnalysis> };
let unmount = () => {};
afterEach(() => unmount());

function render(options: SuggestAnalysisOptions) {
  const result = { current: null as unknown as Probe };
  function Component() {
    const workflow = useAccordWorkflow();
    const analysis = useSuggestAnalysis(workflow, options);
    result.current = { workflow, analysis };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <StrictMode>
        <Component />
      </StrictMode>,
    ),
  );
  let mounted = true;
  unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
  };
  return { result, unmount: () => unmount() };
}

const file = (name: string, csv: string) => new File([csv], name, { type: "text/csv" });

async function toReview(h: { current: Probe }) {
  await act(() => h.current.workflow.chooseFile("A", file("a.csv", SOURCE_A)));
  await act(() => h.current.workflow.chooseFile("B", file("b.csv", SOURCE_B)));
  act(() => {
    for (const side of ["A", "B"] as const)
      for (const [field, columnId] of [["productId", "c0"], ["name", "c1"], ["quantity", "c2"]] as const)
        h.current.workflow.dispatch({ type: "draft/fieldMapped", side, field, columnId });
    h.current.workflow.dispatch({ type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: true });
  });
  await act(async () => {
    await h.current.workflow.confirmMappings();
  });
}

const settle = () => act(async () => {});

describe("useSuggestAnalysis", () => {
  it("does nothing on mount, then runs one execution per started run under Strict Mode", async () => {
    const t = fakeTransport();
    const { result: h } = render({ transport: t.transport, newId: ids() });
    await toReview(h);
    expect(t.calls).toHaveLength(0);
    expect(h.current.analysis.canStart).toBe(true);

    act(() => {
      expect(h.current.analysis.start()).toBe(true);
      expect(h.current.analysis.start()).toBe(false); // double click before commit
    });
    expect(h.current.analysis.status).toBe("running");
    expect(h.current.workflow.state.error).toBeNull();
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(h.current.analysis.start()).toBe(false);

    await act(async () => t.calls[0].resolve(ok(t.calls[0].request)));
    expect(h.current.analysis.status).toBe("complete");
    expect(h.current.analysis.progress).toEqual({ selected: 2, analyzed: 2, failed: 0 });
    expect(h.current.analysis.modelRuns).toMatchObject([{ requestId: "req-1", result: "valid", model: "test/model-1" }]);
    expect(t.calls).toHaveLength(1);
    expect(h.current.workflow.view.counts?.needsReview).toBe(2);
  });

  it("cancels an in-flight run, ignores its late response and can start again", async () => {
    const t = fakeTransport({ ignoreAbort: true });
    const { result: h } = render({ transport: t.transport, newId: ids() });
    await toReview(h);
    act(() => void h.current.analysis.start());
    await settle();
    const old = t.calls[0];
    act(() => {
      h.current.analysis.cancel();
      h.current.analysis.cancel();
    });
    expect(old.signal.aborted).toBe(true);
    expect(h.current.analysis.status).toBe("cancelled");

    act(() => void h.current.analysis.start());
    await settle();
    expect(t.calls).toHaveLength(2);
    await act(async () => old.resolve(ok(old.request)));
    expect(h.current.workflow.state.reconciliation?.proposals).toEqual([]);
    expect(h.current.analysis.status).toBe("running");
    await act(async () => t.calls[1].resolve(ok(t.calls[1].request)));
    expect(h.current.analysis.status).toBe("complete");
    expect(h.current.analysis.modelRuns.map((r) => r.result)).toEqual(["cancelled", "valid"]);
  });

  it("applies a cancel issued before the run committed", async () => {
    const t = fakeTransport();
    const { result: h } = render({ transport: t.transport, newId: ids() });
    await toReview(h);
    act(() => {
      h.current.analysis.start();
      h.current.analysis.cancel();
    });
    await settle();
    expect(t.calls).toHaveLength(0);
    expect(h.current.analysis.status).toBe("cancelled");
  });

  it("aborts the request on unmount", async () => {
    const t = fakeTransport();
    const r = render({ transport: t.transport, newId: ids() });
    await toReview(r.result);
    act(() => void r.result.current.analysis.start());
    await settle();
    r.unmount();
    expect(t.calls[0].signal.aborted).toBe(true);
  });

  it("exposes typed failures without server text", async () => {
    const t = fakeTransport();
    const { result: h } = render({ transport: t.transport, newId: ids() });
    await toReview(h);
    act(() => void h.current.analysis.start());
    await settle();
    await act(async () =>
      t.calls[0].resolve({ status: 503, body: JSON.stringify({ error: { code: "NOT_CONFIGURED", message: "set KEY", retryable: false, requestId: "req-1" } }) }),
    );
    expect(h.current.analysis.status).toBe("failed");
    expect(h.current.analysis.failures).toMatchObject([{ code: "NOT_CONFIGURED", retryable: false, requestId: "req-1" }]);
    expect(h.current.workflow.state.error).toEqual({ kind: "analysis_failed", message: "AI suggestions are not configured on the API server." });
  });
});
