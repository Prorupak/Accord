"use client";

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

function retryGuidance(f: AnalysisFailure): string {
  if (f.retryAfterSeconds !== null) return `You can try again after ${f.retryAfterSeconds} seconds.`;
  return f.retryable ? "You can try again." : "Trying again is unlikely to help; review these records manually.";
}

export function AnalysisPanel({ ai }: { ai: Analysis }) {
  const { status, progress, failures, modelRuns } = ai;
  const last = modelRuns.at(-1);
  // Failures belong to the latest run; after a reset or new sources the status is idle again.
  const shownFailures = status === "idle" ? [] : failures;

  return (
    <section aria-labelledby="ai-title" className="flex flex-col gap-2 rounded border p-3">
      <h3 id="ai-title" className="font-semibold">
        AI suggestions
      </h3>
      <p className="text-sm">
        Sends the mapped fields of up to 20 unmatched Source A records, and their candidate Source B records, to the configured AI
        provider. Suggestions are never applied without your approval.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={!ai.canStart} onClick={() => ai.start()}>
          Run AI suggestions
        </button>
        {status === "running" && (
          <button type="button" className="btn" onClick={() => ai.cancel()}>
            Cancel analysis
          </button>
        )}
      </div>
      <div aria-live="polite">
        <p>Status: {STATUS_TEXT[status]}</p>
        {status !== "idle" && (
          <p>
            {progress.analyzed} of {progress.selected} selected records analyzed
            {progress.failed > 0 ? `, ${progress.failed} failed` : ""}. Completed suggestions are retained.
          </p>
        )}
        {status === "failed" && <p>AI suggestions are unavailable. Exact matches and manual review still work.</p>}
      </div>
      {!ai.canStart && status !== "running" && (
        <p className="text-sm">No unmatched Source A record currently has candidates for AI review.</p>
      )}
      {shownFailures.length > 0 && (
        <ul className="text-sm" aria-label="Analysis errors">
          {shownFailures.map((f, i) => (
            <li key={i}>
              {f.message} ({f.code}) {retryGuidance(f)}
            </li>
          ))}
        </ul>
      )}
      {last && (
        <p className="text-sm">
          Last request: {last.provider || "provider not reported"}, {last.model || "model not reported"}, result {last.result}.
        </p>
      )}
    </section>
  );
}
