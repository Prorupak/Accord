"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReconciliationState } from "../domain/reconcile";
import type { RowId } from "../domain/types";
import type { Analysis, Workflow } from "./AccordApp";
import { AnalysisPanel } from "./AnalysisPanel";
import { RecordDetail, StatusMark, TONE_TEXT } from "./RecordDetail";
import { recordFields } from "./recordFields";
import {
  COMPARISON_LABEL,
  counterpart,
  filterCount,
  FILTERS,
  matchesFilter,
  matchesQuery,
  reviewRows,
  type ReviewFilter,
  type ReviewRow,
  type Tone,
} from "./reviewRows";

// Queue columns from md up; below md each row stacks with the delta at the right.
const QUEUE_COLS = "md:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)_4rem]";

export function ReviewScreen({ workflow, ai }: { workflow: Workflow; ai: Analysis }) {
  const { state, dispatch, view } = workflow;
  const rec = state.reconciliation;
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RowId | null>(null);
  // Below xl the queue and the inspector share one pane; xl and up shows both.
  const [pane, setPane] = useState<"records" | "details">("records");
  const focusInspector = useRef(false);
  const rows = useMemo(() => (rec ? reviewRows(rec) : []), [rec]);

  useEffect(() => {
    if (pane !== "details" || !focusInspector.current) return;
    focusInspector.current = false;
    document.getElementById("detail-title")?.focus();
  }, [pane, selected]);

  if (!rec || !view.counts) return <p>Confirm mappings to start reviewing.</p>;
  const counts = view.counts;
  const visible = rows.filter((r) => matchesFilter(r, filter) && matchesQuery(rec, r, query));
  // The user's choice while it exists; otherwise the first suggestion awaiting review, else the first record.
  const current = rows.find((r) => r.key === selected) ?? rows.find((r) => r.kind === "pending") ?? rows[0] ?? null;

  const choose = (key: RowId) => {
    setSelected(key);
    setPane("details");
    focusInspector.current = window.matchMedia?.("(width < 80rem)").matches ?? false;
  };

  return (
    <section className="flex flex-col gap-6">
      <div>
        <dl aria-label="Summary" className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border bg-line sm:grid-cols-5">
          <Count label="Matched pairs" value={counts.matched} />
          <Count label="Needs review" value={counts.needsReview} tone={counts.needsReview > 0 ? "review" : undefined} />
          <Count label="Unresolved in A" value={counts.unresolvedA} />
          <Count label="Unresolved in B" value={counts.unresolvedB} />
          <Count label="Quantity differences" value={counts.quantityDifferences} wide />
        </dl>
        <p className="mt-2 text-caption text-muted">
          Counts overlap: a matched pair can also have a quantity difference. Matching decides that two records are the same product;
          their quantities can still disagree.
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-10">
        <div className="lg:w-80 lg:shrink-0">
          <h2 className="text-section">
            Reconciliation workspace<span className="text-accent">.</span>
          </h2>
          <p className="mt-1 text-dense text-muted">Inspect original values, resolve uncertainties, and record your decisions.</p>
        </div>
        <AnalysisPanel ai={ai} />
      </div>

      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Show panel" className="flex w-max overflow-hidden rounded-control border xl:hidden">
          {(["records", "details"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={pane === p}
              onClick={() => setPane(p)}
              className={`min-h-control px-4 text-dense font-medium first:border-r ${pane === p ? "bg-accent-soft text-accent" : "bg-surface"}`}
            >
              {p === "records" ? "Records" : "Details"}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-panel border bg-surface xl:grid xl:h-176 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className={`min-h-0 flex-col xl:flex xl:border-r ${pane === "records" ? "flex" : "hidden"}`}>
            <div className="flex flex-col gap-3 border-b p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-heading">Records</h3>
                <p className="text-caption text-muted" aria-live="polite">
                  {visible.length} of {rows.length} shown
                </p>
              </div>
              <div role="group" aria-label="Filter records" className="flex flex-wrap gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={`btn min-h-control-dense px-3 ${filter === f.id ? "" : "border-transparent bg-transparent text-muted"}`}
                  >
                    {f.label} <span className="text-caption tabular-nums">{filterCount(rows, f.id)}</span>
                  </button>
                ))}
              </div>
              <label htmlFor="review-search" className="sr-only">
                Search records by name or product ID
              </label>
              <input
                id="review-search"
                type="search"
                className="w-full min-h-control"
                placeholder="Search names or product IDs"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {/* relative: sr-only labels are absolute and would otherwise escape the scroll clip and stretch the page. */}
            <div className="relative min-h-0 flex-1 xl:overflow-y-auto">
              <div aria-hidden="true" className={`sticky top-0 hidden gap-3 border-b bg-canvas px-4 py-2 text-caption text-muted md:grid ${QUEUE_COLS}`}>
                <span>Status</span>
                <span>Source A</span>
                <span>Source B</span>
                <span className="text-right">Δ B − A</span>
              </div>
              <ul id="review-queue" aria-label="Records in original order">
                {visible.map((row) => (
                  <li key={row.key}>
                    <QueueRow row={row} rec={rec} selected={row.key === current?.key} onSelect={() => choose(row.key)} />
                  </li>
                ))}
              </ul>
              {visible.length === 0 && <p className="p-6 text-center text-dense text-muted">No records match this view.</p>}
            </div>
          </div>

          <div className={`min-h-0 xl:block ${pane === "details" ? "block" : "hidden"}`}>
            {current ? (
              // Pin the shown record so a decision never moves the selection.
              <RecordDetail key={current.key} row={current} workflow={workflow} onDecide={() => setSelected(current.key)} />
            ) : (
              <p className="p-panel text-dense text-muted">There are no records to review.</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        {!view.canExport ? <p className="text-dense text-muted">Export is available once the analysis run ends or is cancelled.</p> : <span />}
        <button type="button" className="btn btn-primary" disabled={!view.canExport} onClick={() => dispatch({ type: "stage/navigated", stage: "export" })}>
          Continue to export
        </button>
      </div>
    </section>
  );
}

function Count({ label, value, tone, wide }: { label: string; value: number; tone?: Tone; wide?: boolean }) {
  return (
    <div className={`bg-surface px-4 py-3 ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <dt className="text-label text-muted">{label}</dt>
      <dd className={`mt-1 text-section tabular-nums ${tone ? TONE_TEXT[tone] : ""}`}>{value}</dd>
    </div>
  );
}

function QueueRow({ row, rec, selected, onSelect }: { row: ReviewRow; rec: ReconciliationState; selected: boolean; onSelect: () => void }) {
  const isB = row.kind === "unresolved" && row.side === "B";
  const delta = row.kind === "pair" ? row.comparison.delta : null;
  const differs = row.kind === "pair" && row.comparison.status === "different";
  // Only accepted pairs compare quantities; any status but "equal" is named in the row.
  const note = row.kind === "pair" && row.comparison.status !== "equal" ? COMPARISON_LABEL[row.comparison.status] : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-l-2 px-4 py-3 text-left text-table transition-colors hover:bg-canvas ${QUEUE_COLS} ${
        selected ? "border-l-accent bg-accent-soft hover:bg-accent-soft" : "border-l-transparent"
      }`}
    >
      <span className="col-start-1 flex flex-col md:col-start-auto">
        <StatusMark row={row} />
        {note && <span className={`text-caption ${differs ? "text-review" : "text-muted"}`}>{note}</span>}
      </span>
      <Product rec={rec} id={isB ? null : row.key} side="A" />
      <Product rec={rec} id={isB ? row.key : counterpart(row)} side="B" suggested={row.kind === "pending"} />
      <span className={`col-start-2 row-start-2 text-right font-medium tabular-nums md:col-start-auto md:row-start-auto ${differs ? "text-review" : ""}`}>
        {delta ?? <span className="text-muted">—</span>}
      </span>
    </button>
  );
}

function Product({ rec, id, side, suggested }: { rec: ReconciliationState; id: RowId | null; side: "A" | "B"; suggested?: boolean }) {
  if (!id)
    return (
      <span className="col-start-1 text-muted md:col-start-auto">
        <span className="sr-only">No Source {side} record</span>
        <span aria-hidden="true">—</span>
      </span>
    );
  const f = recordFields(rec, id);
  return (
    <span className="col-start-1 min-w-0 md:col-start-auto">
      <span className="block font-medium break-words">
        <span className="sr-only">Source {side}: </span>
        <span aria-hidden="true" className="font-normal text-muted md:hidden">
          {side} ·{" "}
        </span>
        {f.name.trim() === "" ? "(no name)" : f.name}
      </span>
      <span className="block font-mono text-caption break-all text-muted">
        {f.productId.trim() === "" ? "No product ID" : f.productId}
        {suggested && " · suggested"}
      </span>
    </span>
  );
}
