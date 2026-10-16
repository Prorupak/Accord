"use client";

import { useEffect, useRef, useState } from "react";
import type { AnalysisFailure } from "../analysis/contract";
import { requestMapSuggestion, type MapSuggestion } from "../analysis/mapSuggestion";
import type { CanonicalField, MappingError } from "../domain/mapping";
import type { Dataset, Side } from "../domain/types";
import { loadedDatasets } from "../workflow/selectors";
import type { Workflow } from "./AccordApp";

const FIELDS: ReadonlyArray<{ field: CanonicalField; label: string; required: boolean }> = [
  { field: "productId", label: "Product ID", required: false },
  { field: "name", label: "Product name", required: true },
  { field: "quantity", label: "Quantity", required: true },
  { field: "unit", label: "Unit", required: false },
];

const ERROR_TEXT: Record<MappingError["code"], string> = {
  required: "Required.",
  unknown_column: "This column does not exist in the file.",
  column_reused: "This column is already mapped to another field.",
};

type MapState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; key: string; suggestion: MapSuggestion }
  | { status: "failed"; error: AnalysisFailure };

const datasetKey = (d: { A: Dataset; B: Dataset }) => `${d.A.id}:${d.B.id}`;

function examples(dataset: Dataset, index: number): string {
  const values = dataset.rows.map((r) => r.cells[index].trim()).filter((v) => v !== "");
  return values.slice(0, 3).join(", ");
}

export function MappingScreen({ workflow }: { workflow: Workflow }) {
  const { state, dispatch, view, confirmMappings } = workflow;
  const datasets = loadedDatasets(state);
  const [mapState, setMapState] = useState<MapState>({ status: "idle" });
  const [confirming, setConfirming] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => () => abort.current?.abort(), []);

  if (!datasets) return <p>Load both sources before mapping columns.</p>;
  const key = datasetKey(datasets);
  // A draft suggested for other files is never shown or applied.
  const suggestion = mapState.status === "ready" && mapState.key === key ? mapState.suggestion : null;
  const { draft } = state;
  const neitherUnit = draft.A.unit === null && draft.B.unit === null;
  const oneUnit = (draft.A.unit === null) !== (draft.B.unit === null);

  const suggest = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setMapState({ status: "loading" });
    const r = await requestMapSuggestion(datasets, { requestId: crypto.randomUUID(), generation: generation.current++, signal: controller.signal });
    if (controller.signal.aborted) return;
    setMapState(r.ok ? { status: "ready", key, suggestion: r.value } : { status: "failed", error: r.error });
  };

  const applySuggestion = (s: MapSuggestion) => {
    for (const side of ["A", "B"] as const)
      for (const { field } of FIELDS) dispatch({ type: "draft/fieldMapped", side, field, columnId: s.draft[side][field] });
  };

  const confirm = async () => {
    setConfirming(true);
    const rec = state.reconciliation;
    await confirmMappings(
      (action) =>
        !rec ||
        action.configurationHash === rec.context.configurationHash ||
        rec.decisions.length + rec.proposals.length === 0 ||
        window.confirm("Changing the confirmed mappings discards your review decisions and AI suggestions. Continue?"),
    );
    setConfirming(false);
  };

  return (
    <section className="flex flex-col gap-4">
      {view.mappingErrors && view.mappingErrors.length > 0 && <p>Select the product-name and quantity columns to continue.</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(["A", "B"] as const).map((side) => (
          <SidePanel key={side} side={side} dataset={datasets[side]} workflow={workflow} suggestion={suggestion} />
        ))}
      </div>

      <fieldset className="flex flex-col gap-2 rounded border p-3">
        <legend className="font-semibold">Matching options</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!draft.idCaseSensitive}
            onChange={(e) => dispatch({ type: "draft/optionSet", option: "idCaseSensitive", value: !e.target.checked })}
          />
          Match product IDs case-insensitively (default: case-sensitive, surrounding spaces trimmed)
        </label>
        {neitherUnit && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.sharedQuantityUnitConfirmed}
              onChange={(e) => dispatch({ type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: e.target.checked })}
            />
            Both quantity columns use the same unit
          </label>
        )}
        {neitherUnit && !draft.sharedQuantityUnitConfirmed && (
          <p className="text-sm">Without this, pairs are still matched but quantity differences are not calculated.</p>
        )}
        {oneUnit && <p className="text-sm">Only one source maps a unit column, so quantity differences cannot be calculated.</p>}
        <p className="text-sm">
          Records whose product IDs are both present but different can never be paired. A product ID that appears more than once
          in either file is quarantined: those records are not matched automatically or manually.
        </p>
      </fieldset>

      <div className="flex flex-col gap-2 rounded border p-3">
        <h2 className="font-semibold">AI mapping draft (optional)</h2>
        <p className="text-sm">Sends the column headers and the first five records of each file to the configured AI provider.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" disabled={mapState.status === "loading"} onClick={() => void suggest()}>
            {mapState.status === "loading" ? "Requesting suggestions…" : "Suggest mappings with AI"}
          </button>
          {suggestion && (
            <button type="button" className="btn" onClick={() => applySuggestion(suggestion)}>
              Apply suggested draft
            </button>
          )}
        </div>
        <div aria-live="polite">
          {mapState.status === "failed" && (
            <p role="alert">
              AI mapping suggestions are unavailable: {mapState.error.message} Manual mapping still works and your current selections
              are unchanged.
            </p>
          )}
          {suggestion && (
            <p>
              Suggestion received from {suggestion.meta.model || "the configured model"}. It is a draft: review each field and apply it
              only if it is correct.
            </p>
          )}
          {suggestion?.warnings.map((w, i) => (
            <p key={i} className="text-sm">
              Warning: {w}
            </p>
          ))}
        </div>
      </div>

      <div>
        <button type="button" className="btn btn-primary" disabled={!view.canConfirmMappings || confirming} onClick={() => void confirm()}>
          Confirm mappings
        </button>
      </div>
    </section>
  );
}

function SidePanel({
  side,
  dataset,
  workflow,
  suggestion,
}: {
  side: Side;
  dataset: Dataset;
  workflow: Workflow;
  suggestion: MapSuggestion | null;
}) {
  const { state, dispatch, view } = workflow;
  const mapping = state.draft[side];
  const header = (id: string | null) => dataset.columns.find((c) => c.id === id)?.header ?? "none";

  return (
    <fieldset className="flex flex-col gap-3 rounded border p-3">
      <legend className="font-semibold">
        Source {side}: {dataset.fileName}
      </legend>
      {FIELDS.map(({ field, label, required }) => {
        const id = `map-${side}-${field}`;
        const errors = view.mappingErrors?.filter((e) => e.side === side && e.field === field) ?? [];
        const usedElsewhere = new Set(FIELDS.filter((f) => f.field !== field).map((f) => mapping[f.field]));
        return (
          <div key={field} className="flex flex-col gap-1">
            <label htmlFor={id}>
              {label} {required ? "(required)" : "(optional)"}
            </label>
            <select
              id={id}
              className="w-full rounded border p-1"
              value={mapping[field] ?? ""}
              aria-invalid={errors.length > 0}
              aria-describedby={errors.length > 0 ? `${id}-error` : undefined}
              onChange={(e) => dispatch({ type: "draft/fieldMapped", side, field, columnId: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">Not mapped</option>
              {dataset.columns.map((c) => (
                <option key={c.id} value={c.id} disabled={usedElsewhere.has(c.id)}>
                  #{c.index + 1} {c.header}: {examples(dataset, c.index) || "(blank)"}
                </option>
              ))}
            </select>
            {errors.length > 0 && (
              <p id={`${id}-error`} className="text-sm text-error">
                {errors.map((e) => ERROR_TEXT[e.code]).join(" ")}
              </p>
            )}
            {suggestion && (
              <p className="text-sm">
                AI draft: {header(suggestion.draft[side][field])}. {suggestion.explanations[side][field]}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
