"use client";

// The application boundary: the only place the workflow and the suggestion orchestrator are
// created. Screens receive them as props, render selectors and dispatch user intents.
import { useSuggestAnalysis } from "../analysis/useSuggestAnalysis";
import { useAccordWorkflow } from "../workflow/useAccordWorkflow";
import { ExportScreen } from "./ExportScreen";
import { ImportScreen } from "./ImportScreen";
import { MappingScreen } from "./MappingScreen";
import { ReviewScreen } from "./ReviewScreen";
import { canEnterStage } from "../workflow/selectors";
import type { Stage, WorkflowError, WorkflowState } from "../workflow/types";

export type Samples = { readonly A: SampleFile; readonly B: SampleFile };
export type SampleFile = { readonly name: string; readonly text: string };

export type Workflow = ReturnType<typeof useAccordWorkflow>;
export type Analysis = ReturnType<typeof useSuggestAnalysis>;

const STAGES: ReadonlyArray<{ id: Stage; label: string }> = [
  { id: "import", label: "1. Import" },
  { id: "mapping", label: "2. Mapping" },
  { id: "review", label: "3. Review" },
  { id: "export", label: "4. Export" },
];

// True when the user may proceed with an action that discards reconciliation work.
export function confirmDiscard(state: WorkflowState, what: string): boolean {
  const rec = state.reconciliation;
  if (!rec || rec.decisions.length + rec.proposals.length === 0) return true;
  return window.confirm(`${what} discards your review decisions and AI suggestions. Continue?`);
}

// Import errors are shown on their source card and analysis failures in the analysis panel.
function bannerMessage(error: WorkflowError | null): string | null {
  if (!error) return null;
  switch (error.kind) {
    case "import_failed":
    case "analysis_failed":
      return null;
    case "invalid_configuration":
      return "Some mappings are invalid. Fix the highlighted fields and confirm again.";
    case "decision_rejected":
      return error.error.message;
    case "stale_configuration":
    case "missing_prerequisite":
    case "invalid_transition":
      return error.message;
  }
}

export function AccordApp({ samples }: { samples: Samples }) {
  const workflow = useAccordWorkflow();
  const ai = useSuggestAnalysis(workflow);
  const { state, dispatch } = workflow;
  const banner = bannerMessage(state.error);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-gutter py-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <h1 className="text-xl font-semibold">Accord</h1>
        <nav aria-label="Workflow stages">
          <ol className="flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`btn ${state.stage === s.id ? "btn-primary" : ""}`}
                  aria-current={state.stage === s.id ? "step" : undefined}
                  disabled={state.stage !== s.id && !canEnterStage(state, s.id)}
                  onClick={() => dispatch({ type: "stage/navigated", stage: s.id })}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <button
          type="button"
          className="btn"
          onClick={() => confirmDiscard(state, "Starting over") && dispatch({ type: "workflow/reset" })}
        >
          Start over
        </button>
      </header>

      {banner && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded border border-error p-3">
          <p>{banner}</p>
          <button type="button" className="btn" onClick={() => dispatch({ type: "error/dismissed" })}>
            Dismiss
          </button>
        </div>
      )}

      <main>
        {state.stage === "import" && <ImportScreen workflow={workflow} samples={samples} />}
        {state.stage === "mapping" && <MappingScreen workflow={workflow} />}
        {state.stage === "review" && <ReviewScreen workflow={workflow} ai={ai} />}
        {state.stage === "export" && <ExportScreen workflow={workflow} ai={ai} />}
      </main>
    </div>
  );
}
