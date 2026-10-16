"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { AnalysisFailure } from "../analysis/contract";
import { requestMapSuggestion, type MapSuggestion } from "../analysis/mapSuggestion";
import type { CanonicalField, MappingError } from "../domain/mapping";
import type { Column, Dataset, Side } from "../domain/types";
import { loadedDatasets } from "../workflow/selectors";
import type { Workflow } from "./AccordApp";

const FIELDS: ReadonlyArray<{ field: CanonicalField; label: string; help: string; required: boolean }> = [
  { field: "name", label: "Product name", help: "The description used to find equivalent products.", required: true },
  { field: "quantity", label: "Quantity", help: "Inventory amount used to calculate differences.", required: true },
  { field: "productId", label: "Product ID", help: "A stable identifier, if your export includes one.", required: false },
  { field: "unit", label: "Unit", help: "Unit of measure, such as pcs, kg or box.", required: false },
];

const ERROR_TEXT: Record<MappingError["code"], string> = {
  required: "Required.",
  unknown_column: "This column does not exist in the file.",
  column_reused: "This column is already mapped to another field.",
};

type MapState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; key: string; suggestion: MapSuggestion; applied: boolean }
  | { status: "failed"; error: AnalysisFailure };

type Ai = { suggestion: MapSuggestion; applied: boolean } | null;

const datasetKey = (d: { A: Dataset; B: Dataset }) => `${d.A.id}:${d.B.id}`;

function examples(dataset: Dataset, index: number): string[] {
  const values = dataset.rows.map((r) => r.cells[index].trim()).filter((v) => v !== "");
  return values.slice(0, 3);
}

// Headers can repeat or be blank; the column number keeps every option distinguishable.
function columnName(dataset: Dataset, c: Column): string {
  if (c.header.trim() === "") return `Column ${c.index + 1}`;
  return dataset.columns.some((o) => o !== c && o.header === c.header) ? `${c.header} (column ${c.index + 1})` : c.header;
}

const icon = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ArrowIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" strokeWidth="1.5" {...icon}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);

const CheckIcon = ({ className }: { className: string }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={className} strokeWidth="2" {...icon}>
    <path d="M3 8.5l3 3 7-7" />
  </svg>
);

function Checkbox({ checked, describedBy, onChange }: { checked: boolean; describedBy: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <span className="relative mt-px grid size-5 shrink-0 place-items-center">
      <input
        type="checkbox"
        className="peer size-5 cursor-pointer appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors duration-(--duration-hover) checked:border-accent checked:bg-accent"
        aria-describedby={describedBy}
        checked={checked}
        onChange={onChange}
      />
      <CheckIcon className="pointer-events-none absolute hidden size-3 text-surface peer-checked:block" />
    </span>
  );
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
  const ai: Ai = mapState.status === "ready" && mapState.key === key ? mapState : null;
  const { draft } = state;
  const neitherUnit = draft.A.unit === null && draft.B.unit === null;
  const oneUnit = (draft.A.unit === null) !== (draft.B.unit === null);
  const requiredDone = (["A", "B"] as const).reduce((n, s) => n + (draft[s].name ? 1 : 0) + (draft[s].quantity ? 1 : 0), 0);
  const ready = view.canConfirmMappings;

  const suggest = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setMapState({ status: "loading" });
    const r = await requestMapSuggestion(datasets, { requestId: crypto.randomUUID(), generation: generation.current++, signal: controller.signal });
    if (controller.signal.aborted) return;
    setMapState(r.ok ? { status: "ready", key, suggestion: r.value, applied: false } : { status: "failed", error: r.error });
  };

  const dismiss = () => {
    abort.current?.abort();
    setMapState({ status: "idle" });
  };

  const applySuggestion = (s: MapSuggestion) => {
    for (const side of ["A", "B"] as const)
      for (const { field } of FIELDS) dispatch({ type: "draft/fieldMapped", side, field, columnId: s.draft[side][field] });
    setMapState({ status: "ready", key, suggestion: s, applied: true });
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

  const status = ready ? "All core fields mapped" : requiredDone === 4 ? "Mappings need attention" : `${requiredDone} of 4 required mappings complete`;
  const statusHelp = ready
    ? neitherUnit && !draft.sharedQuantityUnitConfirmed
      ? "Ready to confirm. Quantities will have unknown unit status until units are confirmed."
      : "Ready to initialize reconciliation using these mappings."
    : requiredDone === 4
      ? "Fix the highlighted fields to continue."
      : "Map the missing product name or quantity field to continue.";

  return (
    <div className="flex flex-col">
      <section aria-label="Imported files" className="grid grid-cols-1 overflow-hidden rounded-panel border bg-surface md:grid-cols-2">
        {(["A", "B"] as const).map((side) => {
          const d = datasets[side];
          return (
            <div key={side} className="flex min-w-0 items-center gap-3 px-4 py-4 not-first:border-t md:px-6 md:py-5 md:not-first:border-t-0 md:not-first:border-l">
              <span
                aria-hidden="true"
                className={`grid size-10.5 shrink-0 place-items-center rounded-control border text-heading ${side === "B" ? "border-accent/25 bg-accent-soft text-accent" : "bg-canvas"}`}
              >
                {side}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-caption font-semibold tracking-wider text-muted uppercase">Source {side}</p>
                <p className="mt-0.5 truncate text-dense font-semibold" title={d.fileName}>
                  {d.fileName}
                </p>
                <p className="text-caption tabular-nums text-muted">
                  {d.rows.length} records · {d.columns.length} columns · {d.byteLength.toLocaleString()} bytes
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-caption font-medium text-success">
                <CheckIcon className="size-3.5" />
                Ready
              </span>
            </div>
          );
        })}
      </section>

      <section aria-labelledby="fields-title" className="pt-10">
        <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 id="fields-title" className="text-section">
              Define the fields<span className="text-accent">.</span>
            </h2>
            <p className="mt-1.5 text-caption text-muted">Choose a corresponding column for each field. Previews show values from the source file.</p>
          </div>
          <div className="flex flex-col gap-1.5 md:items-end">
            <button
              type="button"
              className="btn self-start whitespace-nowrap hover:border-accent hover:text-accent md:self-auto"
              disabled={mapState.status === "loading"}
              aria-busy={mapState.status === "loading"}
              aria-describedby="ai-disclosure"
              onClick={() => void suggest()}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 text-accent" strokeWidth="1.6" {...icon}>
                <path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z" />
                <path d="m20 17 .8 2.2L23 20l-2.2.8L20 23l-.8-2.2L17 20l2.2-.8L20 17Z" />
              </svg>
              {mapState.status === "loading" ? "Requesting suggestions…" : "Suggest mappings with AI"}
            </button>
            {/* <p id="ai-disclosure" className="max-w-xs text-caption text-muted md:text-right">
              Optional. Sends the column headers and the first five records of each file to the configured AI provider.
            </p> */}
          </div>
        </div>

        <div aria-live="polite">
          {mapState.status === "failed" && (
            <section aria-label="AI mapping draft" className="mb-4 flex flex-col gap-4 rounded-panel border bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p role="alert" className="text-caption text-error">
                AI mapping suggestions are unavailable: {mapState.error.message} Manual mapping still works and your current selections are
                unchanged.
              </p>
              <button type="button" className="btn shrink-0 self-start border-transparent bg-transparent text-muted hover:text-ink sm:self-auto" onClick={dismiss}>
                Dismiss
              </button>
            </section>
          )}
          {ai && !ai.applied && (
            <section aria-label="AI mapping draft" className="mb-4 flex flex-col gap-4 rounded-panel border bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-dense font-semibold">Suggested mapping draft is ready</p>
                <p className="mt-0.5 max-w-3xl text-caption text-muted">
                  Suggestion received from {ai.suggestion.meta.model || "the configured model"}. It is a draft: review each field and apply it
                  only if it is correct.
                </p>
                {ai.suggestion.warnings.map((w, i) => (
                  <p key={i} className="mt-1 text-caption text-review">
                    Warning: {w}
                  </p>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className="btn border-transparent bg-transparent text-muted hover:text-ink" onClick={dismiss}>
                  Dismiss
                </button>
                <button type="button" className="btn" onClick={() => applySuggestion(ai.suggestion)}>
                  Apply draft
                  <ArrowIcon />
                </button>
              </div>
            </section>
          )}
          {ai?.applied && <p className="mb-4 text-caption text-muted">AI draft applied. You can still edit every mapping.</p>}
        </div>

        <div className="grid grid-cols-1 overflow-hidden rounded-panel border bg-surface md:grid-cols-2">
          {(["A", "B"] as const).map((side) => (
            <SidePanel key={side} side={side} dataset={datasets[side]} workflow={workflow} ai={ai} />
          ))}
        </div>
        <p className="mt-3 text-caption text-muted">One column can only map to one field within the same file. Optional fields can remain unmapped.</p>
      </section>

      <section aria-labelledby="rules-title" className="pt-8">
        <h2 id="rules-title" className="text-section">
          Comparison rules<span className="text-accent">.</span>
        </h2>
        <p className="mt-1.5 text-caption text-muted">A few decisions about identity and quantities before reconciliation begins.</p>
        <div className="mt-4 grid grid-cols-1 border-y md:grid-cols-2">
          <div className="py-4 md:py-5 md:pr-6">
            <label className="flex cursor-pointer items-start gap-3 text-dense font-semibold">
              <Checkbox
                checked={!draft.idCaseSensitive}
                describedBy="rule-case-help"
                onChange={(e) => dispatch({ type: "draft/optionSet", option: "idCaseSensitive", value: !e.target.checked })}
              />
              Match IDs case-insensitively
            </label>
            <p id="rule-case-help" className="mt-1 ml-8 max-w-md text-caption text-muted">
              By default, <code>abc-01</code> and <code>ABC-01</code> are different. Leading zeros are always preserved.
            </p>
          </div>
          <div className="border-t py-4 md:border-t-0 md:border-l md:py-5 md:pl-6">
            {neitherUnit ? (
              <>
                <label className="flex cursor-pointer items-start gap-3 text-dense font-semibold">
                  <Checkbox
                    checked={draft.sharedQuantityUnitConfirmed}
                    describedBy="rule-unit-help"
                    onChange={(e) => dispatch({ type: "draft/optionSet", option: "sharedQuantityUnitConfirmed", value: e.target.checked })}
                  />
                  Both files use the same quantity unit
                </label>
                <p id="rule-unit-help" className="mt-1 ml-8 max-w-md text-caption text-muted">
                  Use this only when neither source maps a unit column. Otherwise quantity differences are marked as unknown.
                </p>
              </>
            ) : (
              <>
                <p className="text-dense font-semibold">Quantity units</p>
                <p className="mt-1 max-w-md text-caption text-muted">
                  {oneUnit
                    ? "Only one source maps a unit column, so quantity differences cannot be calculated."
                    : "Both sources map a unit column, so units are compared record by record."}
                </p>
              </>
            )}
          </div>
        </div>
        <p className="mt-3 text-caption text-muted">
          <strong className="font-semibold text-ink">Built-in safeguards:</strong> conflicting non-empty product IDs cannot pair; duplicate
          product IDs are quarantined, including for manual matching.
        </p>
      </section>

      <section
        aria-label="Mapping confirmation"
        className="mt-8 flex flex-col gap-4 rounded-panel border bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className={`grid size-9 shrink-0 place-items-center rounded-full ${ready ? "bg-success-soft text-success" : "bg-review-soft text-review"}`}
          >
            <svg viewBox="0 0 24 24" className="size-4.5" strokeWidth="1.8" {...icon}>
              <circle cx="12" cy="12" r="9" />
              {ready ? <path d="m8 12 3 3 5-6" /> : <path d="M12 7v5m0 4h.01" />}
            </svg>
          </span>
          <div role="status">
            <p className="text-dense font-semibold">{status}</p>
            <p className="mt-0.5 text-caption text-muted">{statusHelp}</p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary w-full shrink-0 font-semibold sm:w-auto"
          disabled={!ready || confirming}
          aria-busy={confirming}
          onClick={() => void confirm()}
        >
          Confirm mappings
          <ArrowIcon />
        </button>
      </section>
    </div>
  );
}

function SidePanel({ side, dataset, workflow, ai }: { side: Side; dataset: Dataset; workflow: Workflow; ai: Ai }) {
  const mapping = workflow.state.draft[side];
  const coreLinked = FIELDS.filter((f) => f.required && mapping[f.field] !== null).length;

  return (
    <section aria-labelledby={`panel-${side}-title`} className="min-w-0 px-5 py-6 not-first:border-t md:px-7 md:not-first:border-t-0 md:not-first:border-l">
      <div className="flex items-center justify-between gap-3 border-b pb-5">
        <div className="min-w-0">
          <h3 id={`panel-${side}-title`} className="flex items-center gap-2 text-heading">
            <span aria-hidden="true" className="grid size-6.5 place-items-center rounded-md border text-caption font-normal text-muted">
              {side}
            </span>
            Source {side}
          </h3>
          <p className="mt-1 truncate text-caption text-muted" title={dataset.fileName}>
            {dataset.fileName}
          </p>
        </div>
        <p className="shrink-0 text-caption tabular-nums text-muted">{coreLinked} of 2 core linked</p>
      </div>

      {([true, false] as const).map((required) => {
        const groupId = `group-${side}-${required ? "core" : "optional"}`;
        return (
          <div key={groupId} role="group" aria-labelledby={groupId} className={required ? "pt-6" : "mt-5 border-t pt-6"}>
            <div className="mb-4 flex items-center gap-2.5">
              <span id={groupId} className="text-caption font-semibold tracking-wider text-muted uppercase">
                {required ? "Core fields" : "Optional fields"}
              </span>
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
            </div>
            <div className="flex flex-col gap-6">
              {FIELDS.filter((f) => f.required === required).map((f) => (
                <FieldRow key={f.field} side={side} def={f} dataset={dataset} workflow={workflow} ai={ai} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function FieldRow({
  side,
  def: { field, label, help, required },
  dataset,
  workflow,
  ai,
}: {
  side: Side;
  def: (typeof FIELDS)[number];
  dataset: Dataset;
  workflow: Workflow;
  ai: Ai;
}) {
  const { state, dispatch, view } = workflow;
  const mapping = state.draft[side];
  const id = `map-${side}-${field}`;
  const errors = view.mappingErrors?.filter((e) => e.side === side && e.field === field) ?? [];
  const usedElsewhere = new Set(FIELDS.filter((f) => f.field !== field).map((f) => mapping[f.field]));
  const column = (columnId: string | null) => dataset.columns.find((c) => c.id === columnId) ?? null;
  const selected = column(mapping[field]);
  const values = selected ? examples(dataset, selected.index) : [];

  const suggestedId = ai?.suggestion.draft[side][field] ?? null;
  const suggested = column(suggestedId);
  const suggestedName = suggested ? columnName(dataset, suggested) : "no column";
  const explanation = ai?.suggestion.explanations[side][field];
  const aiState = !ai ? null : !ai.applied ? "draft" : mapping[field] === suggestedId ? (suggestedId ? "suggested" : null) : "edited";
  const differs = aiState === "draft" && mapping[field] !== suggestedId;
  // Before applying, only fields the draft would change carry a hint (prototype behavior).
  const aiLine = aiState === "edited" || aiState === "suggested" || differs;

  const describedBy = [`${id}-help`, `${id}-preview`, aiLine && `${id}-ai`, errors.length > 0 && `${id}-error`].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-dense font-semibold">
          {label}
        </label>
        {differs ? (
          <span className="text-caption font-semibold text-review">AI draft available</span>
        ) : aiState === "suggested" ? (
          <span className="rounded-control bg-review-soft px-1.5 text-caption font-semibold text-review">Suggested</span>
        ) : aiState === "edited" ? (
          <span className="text-caption text-muted">Edited</span>
        ) : (
          <span className="text-caption text-muted">{required ? "Required" : "Optional"}</span>
        )}
      </div>
      <p id={`${id}-help`} className="mt-0.5 mb-2.5 text-caption text-muted">
        {help}
      </p>
      <div className="relative">
        <select
          id={id}
          className={`h-10.5 w-full cursor-pointer appearance-none pr-10 pl-3 text-dense transition-colors duration-(--duration-hover) hover:border-ink ${selected ? "font-medium" : "text-muted"}`}
          value={mapping[field] ?? ""}
          aria-invalid={errors.length > 0}
          aria-describedby={describedBy}
          onChange={(e) => dispatch({ type: "draft/fieldMapped", side, field, columnId: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">Not mapped</option>
          {dataset.columns.map((c) => (
            <option key={c.id} value={c.id} disabled={usedElsewhere.has(c.id)}>
              {columnName(dataset, c)}
            </option>
          ))}
        </select>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" strokeWidth="1.8" {...icon}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {errors.length > 0 && (
        <p id={`${id}-error`} className="mt-1.5 text-caption text-error">
          {errors.map((e) => ERROR_TEXT[e.code]).join(" ")}
        </p>
      )}
      {selected ? (
        <p id={`${id}-preview`} className="mt-3 border-l-2 pt-1.5 pl-3 text-caption">
          <span className="block font-semibold tracking-wider text-muted uppercase">Preview from {selected.header || columnName(dataset, selected)}</span>
          <span className="mt-0.5 block break-words text-ink">{values.length > 0 ? values.join(" · ") : "This column is blank in every record."}</span>
        </p>
      ) : (
        <p id={`${id}-preview`} className="mt-3 pt-1.5 text-caption text-muted">
          Choose a column to preview its values.
        </p>
      )}
      {aiLine && (
        <p id={`${id}-ai`} className={`mt-2 text-caption ${differs ? "border-l-2 border-review pl-3 text-ink" : "text-muted"}`}>
          {aiState === "draft" ? `AI suggests ${suggestedName}. ${explanation}` : aiState === "edited" ? `AI suggested ${suggestedName}.` : explanation}
        </p>
      )}
    </div>
  );
}
