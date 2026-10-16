"use client";

// The application boundary: the only place the workflow and the suggestion orchestrator are
// created. Screens receive them as props, render selectors and dispatch user intents.
import { useSuggestAnalysis } from "../analysis/useSuggestAnalysis";
import { useAccordWorkflow } from "../workflow/useAccordWorkflow";
import { ExportScreen } from "./ExportScreen";
import { ImportScreen } from "./ImportScreen";
import { MappingScreen } from "./MappingScreen";
import { ReviewScreen } from "./ReviewScreen";
import { canEnterStage, loadedDatasets } from "../workflow/selectors";
import type { Stage, WorkflowError, WorkflowState } from "../workflow/types";

export type Samples = { readonly A: SampleFile; readonly B: SampleFile };
export type SampleFile = { readonly name: string; readonly text: string };

export type Workflow = ReturnType<typeof useAccordWorkflow>;
export type Analysis = ReturnType<typeof useSuggestAnalysis>;

const STAGES: ReadonlyArray<{ id: Stage; label: string; title: string; lead: (state: WorkflowState) => string }> = [
  {
    id: "import",
    label: "Import",
    title: "Bring two exports into agreement.",
    lead: () => "Compare product records, review uncertain matches, and export a traceable result.",
  },
  { id: "mapping", label: "Mapping", title: "Understand your columns.", lead: () => "Connect the fields that describe each product." },
  {
    id: "review",
    label: "Review",
    title: "Review the proposed matches.",
    lead: (state) => {
      const d = state.reconciliation?.context.datasets;
      return d ? `Comparing ${d.A.fileName} with ${d.B.fileName}.` : "";
    },
  },
  { id: "export", label: "Export", title: "Export a traceable result.", lead: () => "Download the reconciled records, unresolved items and audit trail." },
];

const step = (i: number) => String(i + 1).padStart(2, "0");

// True when the user may proceed with an action that discards reconciliation work.
export function confirmDiscard(state: WorkflowState, what: string): boolean {
  const rec = state.reconciliation;
  if (!rec || rec.decisions.length + rec.proposals.length === 0) return true;
  return window.confirm(`${what} discards your review decisions and AI suggestions. Continue?`);
}

// Import errors are shown on their source card and analysis failures in the analysis panel.
function banner(error: WorkflowError | null): { title: string; message: string } | null {
  if (!error) return null;
  switch (error.kind) {
    case "import_failed":
    case "analysis_failed":
      return null;
    case "invalid_configuration":
      return { title: "Mappings need attention", message: "Some mappings are invalid. Fix the highlighted fields and confirm again." };
    case "decision_rejected":
      return { title: "Decision not applied", message: error.error.message };
    case "stale_configuration":
      return { title: "Mappings changed", message: error.message };
    case "missing_prerequisite":
      return { title: "Step not available", message: error.message };
    case "invalid_transition":
      return { title: "Action not available", message: error.message };
  }
}

// Only what state can prove: both files loaded, mappings confirmed. Review and Export never are.
function isComplete(state: WorkflowState, stage: Stage): boolean {
  if (stage === "import") return loadedDatasets(state) !== null;
  if (stage === "mapping") return state.reconciliation !== null;
  return false;
}

const hasWork = (state: WorkflowState) =>
  state.sources.A.dataset !== null || state.sources.B.dataset !== null || state.reconciliation !== null;

export function AccordApp({ samples }: { samples: Samples }) {
  const workflow = useAccordWorkflow();
  const ai = useSuggestAnalysis(workflow);
  const { state, dispatch } = workflow;
  const alert = banner(state.error);
  const at = STAGES.findIndex((s) => s.id === state.stage);
  const intro = STAGES[at];

  const startOver = () => {
    if (hasWork(state) && !window.confirm("Start over? This clears both imported files, the mappings and any review decisions.")) return;
    dispatch({ type: "workflow/reset" });
  };

  return (
    <>
      <header className="h-header border-b bg-surface">
        <div className="mx-auto flex h-full max-w-content items-center justify-between gap-4 px-gutter">
          <p className="text-section">
            accord<span className="text-accent">.</span>
          </p>
          <button type="button" className="btn border-transparent bg-transparent" onClick={startOver}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
              <path d="M2.5 2v3h3" />
            </svg>
            Start over
          </button>
        </div>
      </header>

      {/* The one content width; Review may switch it per stage when its workspace widens. */}
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-gutter pt-6 pb-16">
        <nav aria-label="Workflow">
          <ol className="grid grid-cols-4 gap-1 sm:gap-2">
            {STAGES.map((s, i) => {
              const current = state.stage === s.id;
              const complete = !current && isComplete(state, s.id);
              const bar = current ? "border-accent" : complete ? "border-ink" : "border-line";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`flex min-h-control w-full items-center gap-1 border-b-2 px-1 text-left text-dense disabled:cursor-not-allowed disabled:text-muted enabled:hover:text-accent ${bar} ${current ? "font-semibold" : ""}`}
                    aria-current={current ? "step" : undefined}
                    disabled={!current && !canEnterStage(state, s.id)}
                    onClick={() => dispatch({ type: "stage/navigated", stage: s.id })}
                  >
                    {complete ? (
                      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 text-success" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8.5l3 3 7-7" />
                      </svg>
                    ) : (
                      <span className="text-caption tabular-nums text-muted">{step(i)}</span>
                    )}{" "}
                    {s.label}
                    {complete && <span className="sr-only">, complete</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div>
          <p className="text-label uppercase tracking-wide text-muted">
            {step(at)} / {intro.label}
          </p>
          <h1 id="stage-title" className="mt-2 text-page">
            {intro.title}
          </h1>
          <p className="mt-2 text-muted">{intro.lead(state)}</p>
        </div>

        {alert && (
          <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-panel border border-error bg-error-soft p-4">
            <div>
              <p className="text-heading text-error">{alert.title}</p>
              <p className="text-dense">{alert.message}</p>
            </div>
            <button type="button" className="btn" onClick={() => dispatch({ type: "error/dismissed" })}>
              Dismiss
            </button>
          </div>
        )}

        <main aria-labelledby="stage-title">
          {state.stage === "import" && <ImportScreen workflow={workflow} samples={samples} />}
          {state.stage === "mapping" && <MappingScreen workflow={workflow} />}
          {state.stage === "review" && <ReviewScreen workflow={workflow} ai={ai} />}
          {state.stage === "export" && <ExportScreen workflow={workflow} ai={ai} />}
        </main>
      </div>
    </>
  );
}
