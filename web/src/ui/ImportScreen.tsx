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
    <section aria-labelledby="import-title" className="flex flex-col gap-4">
      <div>
        <h2 id="import-title" className="text-lg font-semibold">
          Bring two exports into agreement.
        </h2>
        <p>Compare product records, review uncertain matches, and export a traceable result.</p>
        {!state.sources.A.dataset && !state.sources.B.dataset && <p>Choose two CSV exports, or explore the sample.</p>}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SourceCard side="A" workflow={workflow} />
        <SourceCard side="B" workflow={workflow} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={loadSamples}>
          Try sample data
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!bothLoaded}
          onClick={() => dispatch({ type: "stage/navigated", stage: "mapping" })}
        >
          Continue to mapping
        </button>
      </div>

      <p className="text-sm">
        Your files are parsed and held in this browser session only; nothing is saved. When you ask for AI help, the selected
        column headers, sample cells and candidate fields are sent to the configured AI provider.
      </p>
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

  return (
    <div
      className={`flex flex-col gap-2 rounded border p-3 ${dragging ? "border-accent" : ""}`}
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
      <h3 className="font-semibold">Source {side}</h3>
      <label htmlFor={inputId}>Choose Source {side} (CSV, or drop a file here)</label>
      <input
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = ""; // allows choosing the same file again
        }}
      />
      <p aria-live="polite">{pendingToken ? "Reading file…" : dataset ? "Valid CSV" : "No file loaded"}</p>
      {dataset && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <dt>File</dt>
          <dd>{dataset.fileName}</dd>
          <dt>Size</dt>
          <dd>{dataset.byteLength.toLocaleString()} bytes</dd>
          <dt>Records</dt>
          <dd>{dataset.rows.length}</dd>
          <dt>Columns</dt>
          <dd>{dataset.columns.length}</dd>
          {dataset.parse.ignoredBlankRecords > 0 && (
            <>
              <dt>Blank lines skipped</dt>
              <dd>{dataset.parse.ignoredBlankRecords}</dd>
            </>
          )}
        </dl>
      )}
      {error && (
        <p role="alert" className="text-error">
          Could not import this file: {error.message}
          {error.recordIndex !== undefined && ` (data record ${error.recordIndex + 1}`}
          {error.recordIndex !== undefined && error.columnIndex !== undefined && `, column ${error.columnIndex + 1}`}
          {error.recordIndex !== undefined && ")"}
        </p>
      )}
      {dataset && (
        <button
          type="button"
          className="btn self-start"
          onClick={() => confirmDiscard(state, `Clearing Source ${side}`) && dispatch({ type: "source/cleared", side })}
        >
          Clear Source {side}
        </button>
      )}
    </div>
  );
}
