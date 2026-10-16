"use client";

import { useState, type ReactNode } from "react";
import pkg from "../../package.json";
import type { Analysis, Workflow } from "./AccordApp";
import { ARTIFACTS, useExportArtifacts, type ArtifactName, type PrepareResult } from "./useExportArtifacts";

const pad = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const FILE_LINES: Record<ArtifactName, string> = {
  "matches.csv": "M19 1v8h8M8 17h14M8 22h14M8 27h6m3 0h5",
  "unresolved.csv": "M19 1v8h8M8 17h14M8 22h14M8 27h7",
  "audit.json": "M19 1v8h8M10 18l-3 3 3 3m12-6 3 3-3 3M17 16l-3 11",
};

const FILES: Record<ArtifactName, { label: string; ext: string; description: string }> = {
  "matches.csv": {
    label: "Accepted pairs",
    ext: "CSV",
    description: "Accepted Source A ↔ Source B pairs, match reasons, original quantities and their calculated differences.",
  },
  "unresolved.csv": {
    label: "Unpaired records",
    ext: "CSV",
    description: "Every unpaired record from both sources, with the reason it was left unresolved.",
  },
  "audit.json": {
    label: "Replayable audit",
    ext: "JSON",
    description: "Original parsed rows, mapping configuration, decisions and evidence needed for local audit replay.",
  },
};

function Arrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h15m-6-6 6 6-6 6" />
    </svg>
  );
}

function SectionHead({ id, title, sub, aside }: { id: string; title: string; sub: string; aside: string }) {
  return (
    <div className="flex items-end justify-between gap-5">
      <div>
        <h2 id={id} className="text-section">
          {title}
          <span className="text-accent">.</span>
        </h2>
        <p className="mt-1.5 max-w-2xl text-label text-muted">{sub}</p>
      </div>
      <span className="shrink-0 text-caption uppercase tracking-wide text-muted">{aside}</span>
    </div>
  );
}

function Note({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <section className="py-5 md:pr-7 md:not-first:border-l md:not-first:pl-7 max-md:not-first:border-t">
      <p className="text-caption font-semibold uppercase tracking-wide text-muted">{label}</p>
      <h3 className="mt-2 text-dense font-semibold">{title}</h3>
      <p className="mt-1 text-label leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-ink">{children}</p>
    </section>
  );
}

export function ExportScreen({ workflow, ai }: { workflow: Workflow; ai: Analysis }) {
  const { state, view, dispatch } = workflow;
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

  const status = artifacts
    ? {
        tone: "border-success/30 bg-success-soft text-success",
        title: "Export prepared",
        copy: "The snapshot has been prepared for this revision. All three downloads belong to the same result.",
        caption: (
          <>
            Prepared from <strong>revision {artifacts.snapshot.revision}</strong> · No changes since preparation
          </>
        ),
        action: "Prepare again",
      }
    // Leaving Export unmounts this screen and the hook revokes its URLs, so a returning user always
    // starts from an unprepared, current revision; no stale snapshot can be on screen.
    : {
        tone: "border-line bg-canvas text-muted",
        title: "Ready to prepare",
        copy: "The current decisions are ready for a consistency check. Downloads become available only after preparation succeeds.",
        caption: (
          <>
            Current reconciliation <strong>revision {rec.revision}</strong>
          </>
        ),
        action: "Prepare export",
      };

  const summary = [
    { label: "Matched pairs", value: c.matched, below: "Accepted one-to-one" },
    { label: "Unresolved in A", value: c.unresolvedA, below: "Still in the handoff" },
    { label: "Unresolved in B", value: c.unresolvedB, below: "Still in the handoff" },
    { label: "Quantity differences", value: c.quantityDifferences, below: "Across matched pairs" },
  ];
  const fileCounts: Record<ArtifactName, string> = {
    "matches.csv": plural(c.matched, "matched pair", "matched pairs"),
    "unresolved.csv": plural(c.unresolvedA + c.unresolvedB, "unresolved record", "unresolved records"),
    "audit.json": "1 audit snapshot",
  };

  return (
    <div className="flex flex-col">
      <dl aria-describedby="summary-note" className="grid grid-cols-2 overflow-hidden rounded-panel border bg-surface md:grid-cols-4">
        {summary.map((m, i) => (
          <div key={m.label} className={`min-w-0 px-4 py-3 md:px-6 md:py-4 ${i % 2 ? "border-l" : ""} ${i > 1 ? "max-md:border-t" : ""} ${i === 2 ? "md:border-l" : ""}`}>
            <dt className="text-caption text-muted">{m.label}</dt>
            <dd className="mt-1 text-section tabular-nums md:text-page">
              <span aria-hidden="true">{pad(m.value)}</span>
              <span className="sr-only">{m.value}</span>
            </dd>
            <dd className="mt-1 text-caption text-muted">{m.below}</dd>
          </div>
        ))}
      </dl>
      <p id="summary-note" className="mt-2 text-caption text-muted">
        Counts overlap: a matched pair can also have a quantity difference. The package retains unresolved records without pairing them automatically.
      </p>

      <section aria-labelledby="prepare-title" className="mt-10">
        <SectionHead
          id="prepare-title"
          title="Prepare your handoff"
          sub="Freeze the current reconciliation revision, validate its invariants, then download the three files below."
          aside="Package / 01"
        />
        <div className="mt-4 grid items-center gap-4 rounded-panel border bg-surface p-4 md:grid-cols-[1fr_auto] md:gap-5 md:px-6 md:py-5">
          <div className="flex items-start gap-3">
            <div className={`grid size-10 shrink-0 place-items-center rounded-control border ${status.tone}`}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 2.5h7l4.5 4.5V21H7a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z" />
                <path d="M14 2.5V8h4.5M9 13h6m-6 4h6" />
              </svg>
            </div>
            <div className="min-w-0">
              <div role="status">
                <h3 className="text-heading">{status.title}</h3>
              </div>
              <p className="mt-1 max-w-xl text-label text-muted">{status.copy}</p>
              <p className="mt-2 text-caption text-muted [&_strong]:font-semibold [&_strong]:text-ink">{status.caption}</p>
              {!view.canExport && <p className="mt-2 text-caption text-review">Wait for the AI analysis to finish before preparing.</p>}
            </div>
          </div>
          <button type="button" className="btn btn-primary w-full font-semibold md:w-auto md:min-w-44" disabled={!view.canExport} onClick={onPrepare}>
            {status.action}
            <Arrow />
          </button>

          {failure && (
            <div role="alert" className="border-l-2 border-error bg-error-soft px-4 py-3 text-label md:col-span-2">
              {failure.violations ? (
                <>
                  <p>Export blocked: the reconciliation failed an internal consistency check, so nothing was exported.</p>
                  <ul className="mt-1 list-disc pl-5">
                    {failure.violations.map((v, i) => (
                      <li key={i}>{v.message}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>The download files could not be created. Try preparing the export again.</p>
              )}
            </div>
          )}
        </div>

        {(incomplete || c.needsReview > 0) && (
          <div className="mt-3 border-l-2 border-review bg-review-soft px-4 py-3 text-label">
            {incomplete && (
              <p>
                <strong className="text-review">AI analysis was incomplete ({ai.status}).</strong> Verified suggestions and your decisions are kept.
                Records it did not analyze are exported as unresolved.
              </p>
            )}
            {c.needsReview > 0 && (
              <p className={incomplete ? "mt-1" : ""}>
                {plural(c.needsReview, "AI suggestion was", "AI suggestions were")} not reviewed; their records are exported as unresolved.
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="package-title" className="mt-10">
        <SectionHead id="package-title" title="Inside the package" sub="Three separate downloads, produced from the same validated snapshot." aside="03 Files" />
        <ul className="mt-4 grid overflow-hidden rounded-panel border bg-surface lg:grid-cols-3">
          {ARTIFACTS.map((a, i) => {
            const f = FILES[a.name];
            return (
              <li key={a.name} className="flex min-w-0 flex-col p-5 max-lg:not-first:border-t lg:not-first:border-l">
                <article aria-labelledby={`file-${i}`} className="flex flex-1 flex-col">
                  <span className="text-caption uppercase tabular-nums text-muted">
                    {pad(i + 1)} / {f.label}
                  </span>
                  <svg aria-hidden="true" viewBox="0 0 32 40" className="mt-3 mb-3 h-10 w-8" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M5 1h14l8 8v28a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" />
                    <path d={FILE_LINES[a.name]} />
                  </svg>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 id={`file-${i}`} className="text-heading break-all">
                      {a.name}
                    </h3>
                    <span className="text-caption uppercase tracking-wide text-muted">{f.ext}</span>
                  </div>
                  <p className="mt-2 text-label text-muted">{f.description}</p>
                  <div className="mt-auto flex min-h-control items-center justify-between gap-2 pt-4">
                    <span className="text-caption font-semibold tabular-nums">{fileCounts[a.name]}</span>
                    {artifacts ? (
                      <a
                        className="inline-flex min-h-control items-center gap-1.5 text-caption font-semibold text-accent hover:underline"
                        href={artifacts.urls[a.name]}
                        download={a.name}
                        type={a.type}
                        onClick={(e) => {
                          if (!isStillCurrent()) e.preventDefault();
                        }}
                      >
                        Download<span className="sr-only"> {a.name}</span>
                        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
                        </svg>
                      </a>
                    ) : (
                      <span className="text-caption text-muted">Prepare first</span>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-8 grid border-y md:grid-cols-2">
        <Note label="01 / Nothing hidden" title="Unresolved is still a valid result.">
          Ambiguities, duplicate identifiers and unpaired rows stay visible. <strong>Export does not imply every product was matched.</strong>
        </Note>
        <Note label="02 / Handle with care" title="Your audit includes source data.">
          <strong>audit.json contains original parsed records and cited evidence.</strong> Share it only with people authorized to see both
          source files. Replay verifies consistency, not tamper-proof authenticity.
        </Note>
      </div>

      <div className="mt-4">
        <button
          type="button"
          className="inline-flex min-h-control items-center gap-2 text-label font-semibold text-muted hover:text-accent"
          onClick={() => dispatch({ type: "stage/navigated", stage: "review" })}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 12H5m6-6-6 6 6 6" />
          </svg>
          Back to review
        </button>
      </div>
    </div>
  );
}
