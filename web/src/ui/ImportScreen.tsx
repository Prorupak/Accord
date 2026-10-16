"use client";

import { useState } from "react";
import type { Side } from "../domain/types";
import { confirmDiscard, type Samples, type Workflow } from "./AccordApp";

export function ImportScreen({ workflow, samples }: { workflow: Workflow; samples: Samples }) {
  const { state, dispatch, chooseFile } = workflow;
  const bothLoaded = state.sources.A.dataset !== null && state.sources.B.dataset !== null;

  const loadSamples = () => {
    if (!confirmDiscard(state, "Loading the sample")) return;
    for (const side of ["A", "B"] as const)
      void chooseFile(side, new File([samples[side].text], samples[side].name, { type: "text/csv" }));
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SourceCard side="A" workflow={workflow} />
        <SourceCard side="B" workflow={workflow} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className="min-h-control text-dense text-muted hover:text-ink" onClick={loadSamples}>
          Or explore with sample data
        </button>
        <button
          type="button"
          className="btn btn-primary disabled:border-transparent disabled:bg-canvas disabled:text-ink disabled:opacity-100"
          disabled={!bothLoaded}
          onClick={() => dispatch({ type: "stage/navigated", stage: "mapping" })}
        >
          Continue
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      </div>
    </section>
  );
}

function SourceCard({ side, workflow }: { side: Side; workflow: Workflow }) {
  const { state, dispatch, chooseFile } = workflow;
  const { dataset, pendingToken } = state.sources[side];
  const error = state.error?.kind === "import_failed" && state.error.side === side ? state.error.error : null;
  const [dragging, setDragging] = useState(false);
  const inputId = `source-${side}-file`;

  const choose = (file: File | undefined) => {
    if (file && confirmDiscard(state, `Replacing Source ${side}`)) void chooseFile(side, file);
  };

  const zone = dragging ? "border-accent bg-accent-soft" : error ? "border-error" : "border-line-strong";
  const facts = dataset && [
    "Valid CSV",
    `${dataset.rows.length} records`,
    `${dataset.columns.length} columns`,
    `${dataset.byteLength.toLocaleString()} bytes`,
    ...(dataset.parse.ignoredBlankRecords > 0 ? [`${dataset.parse.ignoredBlankRecords} blank lines skipped`] : []),
  ];

  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        choose(e.dataTransfer.files[0]);
      }}
    >
      <label
        htmlFor={inputId}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-panel border border-dashed px-4 py-8 text-center has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${zone}`}
      >
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = ""; // allows choosing the same file again
          }}
        />
        <svg aria-hidden="true" viewBox="0 0 20 20" className="mb-1 size-5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11.5 2.5H5.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-10z" />
          <path d="M11.5 2.5v4h4M10 14.5v-5M7.5 12l2.5-2.5 2.5 2.5" />
        </svg>
        <span className="font-medium break-all">
          {dataset ? (
            <>
              <span className="sr-only">Source {side}: </span>
              {dataset.fileName}
            </>
          ) : (
            `Source ${side}`
          )}
        </span>
        <span aria-live="polite" className="text-caption text-muted">
          {pendingToken ? "Reading file…" : facts ? facts.join(" · ") : "Choose or drop a CSV"}
        </span>
      </label>
      {error && (
        <p role="alert" className="text-dense text-error">
          Could not import this file: {error.message}
          {error.recordIndex !== undefined && ` (data record ${error.recordIndex + 1}`}
          {error.recordIndex !== undefined && error.columnIndex !== undefined && `, column ${error.columnIndex + 1}`}
          {error.recordIndex !== undefined && ")"}
        </p>
      )}
      {dataset && (
        <button
          type="button"
          className="btn self-start border-transparent bg-transparent"
          onClick={() => confirmDiscard(state, `Clearing Source ${side}`) && dispatch({ type: "source/cleared", side })}
        >
          Clear Source {side}
        </button>
      )}
    </div>
  );
}
