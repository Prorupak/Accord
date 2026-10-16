// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_A, SOURCE_B } from "./testkit";
import { useAccordWorkflow } from "./useAccordWorkflow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useAccordWorkflow>;
let unmount = () => {};
afterEach(() => unmount());

function renderWorkflow() {
  const result = { current: null as unknown as Hook };
  function Probe() {
    result.current = useAccordWorkflow();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  unmount = () => act(() => root.unmount());
  return result;
}

const file = (name: string, csv: string) => new File([csv], name, { type: "text/csv" });

describe("useAccordWorkflow", () => {
  it("drives the reducer end to end and exposes derived views", async () => {
    const hook = renderWorkflow();
    expect(hook.current.state.stage).toBe("import");

    await act(() => hook.current.chooseFile("A", file("a.csv", SOURCE_A)));
    await act(() => hook.current.chooseFile("B", file("b.csv", SOURCE_B)));
    expect(hook.current.state.sources.B.dataset?.rows).toHaveLength(4);

    act(() => {
      for (const side of ["A", "B"] as const)
        for (const [field, columnId] of [["productId", "c0"], ["name", "c1"], ["quantity", "c2"]] as const)
          hook.current.dispatch({ type: "draft/fieldMapped", side, field, columnId });
      hook.current.dispatch({ type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: true });
    });
    expect(hook.current.view.canConfirmMappings).toBe(true);

    await act(async () => {
      await hook.current.confirmMappings();
    });
    expect(hook.current.state.stage).toBe("review");
    expect(hook.current.view.counts?.matched).toBe(2);

    const rec = hook.current.state.reconciliation!;
    const [left, right] = [rec.context.datasets.A.rows[1].id, rec.context.datasets.B.rows[1].id];
    act(() => {
      hook.current.decide("accept", left, right);
    });
    expect(hook.current.view.counts?.matched).toBe(3);
    expect(hook.current.state.reconciliation?.decisions[0]).toMatchObject({ action: "accept", leftId: left, rightId: right });

    act(() => hook.current.dispatch({ type: "analysis/started" }));
    expect(hook.current.view.analysisStatus).toBe("running");
    expect(hook.current.view.activeRun?.selectedRowIds).toEqual([rec.context.datasets.A.rows[3].id]);
  });

  it("surfaces a rejected decision without changing reconciliation", async () => {
    const hook = renderWorkflow();
    act(() => {
      hook.current.decide("accept", "A:x:0", "B:x:0");
    });
    expect(hook.current.state.error).toMatchObject({ kind: "missing_prerequisite" });
    expect(hook.current.view.hasRecoverableError).toBe(true);
    expect(hook.current.state.reconciliation).toBeNull();
  });
});
