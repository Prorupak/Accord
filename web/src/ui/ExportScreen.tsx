"use client";

import { useState } from "react";
import pkg from "../../package.json";
import type { Analysis, Workflow } from "./AccordApp";
import { ARTIFACTS, useExportArtifacts, type PrepareResult } from "./useExportArtifacts";

export function ExportScreen({ workflow, ai }: { workflow: Workflow; ai: Analysis }) {
  const { state, view } = workflow;
  const rec = state.reconciliation;
  const { artifacts, prepare, isStillCurrent } = useExportArtifacts(rec);
  const [failure, setFailure] = useState<Exclude<PrepareResult, { ok: true }> | null>(null);
  if (!rec || !view.counts) return <p>Confirm mappings before exporting.</p>;
  const c = view.counts;
  const incomplete = ai.status === "partial" || ai.status === "cancelled" || ai.status === "failed";

  const onPrepare = () => {
    const r = prepare({ appVersion: pkg.version, generatedAt: new Date().toISOString(), runId: crypto.randomUUID(), modelRuns: [...ai.modelRuns] });
    setFailure(r.ok ? null : r);
  };

  return (
    <section aria-labelledby="export-title" className="flex flex-col gap-4">
      <h2 id="export-title" className="text-lg font-semibold">
        Export
      </h2>
      <p>
        {c.matched} matched {c.matched === 1 ? "pair" : "pairs"}. {c.unresolvedA} unresolved {c.unresolvedA === 1 ? "record" : "records"} in A,{" "}
        {c.unresolvedB} in B. {c.quantityDifferences} matched {c.quantityDifferences === 1 ? "pair has" : "pairs have"} a quantity difference.
      </p>
      {c.unresolvedA + c.unresolvedB > 0 && <p>Unresolved records are exported to unresolved.csv with their reasons.</p>}
      {c.needsReview > 0 && <p>{c.needsReview} AI suggestions were not reviewed; their records are exported as unresolved.</p>}
      {incomplete && <p>AI analysis was incomplete ({ai.status}). Records it did not analyze are exported as unresolved.</p>}

      <div>
        <button type="button" className="btn btn-primary" disabled={!view.canExport} onClick={onPrepare}>
          Prepare export
        </button>
      </div>

      <div aria-live="polite">
        {failure?.violations && (
          <div role="alert">
            <p>Export blocked: the reconciliation failed an internal consistency check, so nothing was exported.</p>
            <ul>
              {failure.violations.map((v, i) => (
                <li key={i}>{v.message}</li>
              ))}
            </ul>
          </div>
        )}
        {failure && !failure.violations && <p role="alert">The download files could not be created. Try preparing the export again.</p>}
        {artifacts && <p>Export prepared from revision {artifacts.snapshot.revision}. Any further change invalidates these files.</p>}
      </div>

      {artifacts && (
        <ul className="flex flex-wrap gap-2">
          {ARTIFACTS.map((a) => (
            <li key={a.name}>
              <a
                className="btn inline-flex items-center"
                href={artifacts.urls[a.name]}
                download={a.name}
                type={a.type}
                onClick={(e) => {
                  if (!isStillCurrent()) e.preventDefault();
                }}
              >
                Download {a.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        audit.json contains the original parsed records, every decision and the cited evidence. It may contain sensitive data; share
        it only with people who may see both source files.
      </p>
    </section>
  );
}
