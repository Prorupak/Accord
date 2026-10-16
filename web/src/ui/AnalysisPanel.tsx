"use client";

import type { AiAvailability } from "../analysis/availability";
import type { AnalysisFailure } from "../analysis/contract";
import type { TaskStatus } from "../domain/types";
import type { Analysis } from "./AccordApp";

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: "Not run",
  running: "Running",
  partial: "Partial: some selected records were not analyzed",
  complete: "Complete",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  idle: "bg-line-strong",
  running: "bg-accent",
  partial: "bg-review",
  complete: "bg-success",
  cancelled: "bg-review",
  failed: "bg-error",
};

function retryGuidance(f: AnalysisFailure): string {
  if (f.retryAfterSeconds !== null) return `You can try again after ${f.retryAfterSeconds} seconds.`;
  return f.retryable ? "You can try again." : "Trying again is unlikely to help; review these records manually.";
}

export function AnalysisPanel({ ai, availability }: { ai: Analysis; availability: AiAvailability }) {
  const { status, progress, failures, modelRuns } = ai;
  const last = modelRuns.at(-1);
  // Failures belong to the latest run; after a reset or new sources the status is idle again.
  const shownFailures = status === "idle" ? [] : failures;

  if (availability !== "available")
    return (
      <section aria-labelledby="ai-title" className="flex min-w-0 flex-1 flex-col gap-0.5 border-t pt-4 text-dense lg:border-t-0 lg:pt-0">
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-line-strong" />
          <span id="ai-title" className="font-semibold">
            AI suggestions
          </span>
          <span className="text-muted">Status: {availability === "off" ? "Unavailable in this hosted version" : "Sample data only"}</span>
        </p>
        <p className="text-muted">
          {availability === "off" ? "Nothing is sent to an AI provider." : "Your files are not sent anywhere. In this hosted version, AI suggestions run only on the sample data."}{" "}
          Exact matches and manual review still work.
        </p>
      </section>
    );

  return (
    <section aria-labelledby="ai-title" className="flex min-w-0 flex-1 flex-col gap-2 border-t pt-4 lg:border-t-0 lg:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-live="polite" className="flex flex-col gap-0.5 text-dense">
          <p className="flex items-center gap-2">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
            <span id="ai-title" className="font-semibold">
              AI suggestions
            </span>
            <span className="text-muted">Status: {STATUS_TEXT[status]}</span>
          </p>
          {status !== "idle" && (
            <p className="text-muted">
              {progress.analyzed} of {progress.selected} selected records analyzed
              {progress.failed > 0 ? `, ${progress.failed} failed` : ""}. Completed suggestions are retained.
            </p>
          )}
          {status === "failed" && <p>AI suggestions are unavailable. Exact matches and manual review still work.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {status === "running" && (
            <button type="button" className="btn" onClick={() => ai.cancel()}>
              Cancel analysis
            </button>
          )}
          <button type="button" className="btn" disabled={!ai.canStart} aria-describedby="ai-disclosure" onClick={() => ai.start()}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M8 1.5l1.2 4.3 4.3 1.2-4.3 1.2L8 12.5 6.8 8.2 2.5 7l4.3-1.2z" />
            </svg>
            Run AI suggestions
          </button>
        </div>
      </div>
      {shownFailures.length > 0 && (
        <ul className="border-l-2 border-error bg-error-soft px-3 py-2 text-dense" aria-label="Analysis errors">
          {shownFailures.map((f, i) => (
            <li key={i}>
              {f.message} ({f.code}) {retryGuidance(f)}
            </li>
          ))}
        </ul>
      )}
      <p id="ai-disclosure" className="text-caption text-muted">
        Sends the mapped names and product IDs of up to 20 unmatched Source A records, and of their eligible Source B candidates, to the
        configured AI provider. Quantities are not sent. Suggestions are never applied without your approval.
        {!ai.canStart && status !== "running" && " No unmatched Source A record currently has candidates for AI review."}
      </p>
      {last && (
        <p className="text-caption text-muted">
          Last request: {last.provider || "provider not reported"}, {last.model || "model not reported"}, result {last.result}.
        </p>
      )}
    </section>
  );
}
