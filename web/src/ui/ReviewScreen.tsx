"use client";

import { useMemo, useState } from "react";
import type { RowId } from "../domain/types";
import type { Analysis, Workflow } from "./AccordApp";
import { AnalysisPanel } from "./AnalysisPanel";
import { RecordDetail } from "./RecordDetail";
import { describe, recordFields } from "./recordFields";
import { COMPARISON_LABEL, FILTERS, matchesFilter, reviewRows, statusLabel, type ReviewFilter, type ReviewRow } from "./reviewRows";

export function ReviewScreen({ workflow, ai }: { workflow: Workflow; ai: Analysis }) {
  const { state, dispatch, view } = workflow;
  const rec = state.reconciliation;
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [selected, setSelected] = useState<RowId | null>(null);
  const rows = useMemo(() => (rec ? reviewRows(rec) : []), [rec]);
  if (!rec || !view.counts) return <p>Confirm mappings to start reviewing.</p>;
  const counts = view.counts;
  const visible = rows.filter((r) => matchesFilter(r, filter));
  const selectedRow = rows.find((r) => r.key === selected) ?? null;

  return (
    <section aria-labelledby="review-title" className="flex flex-col gap-4">
      <h2 id="review-title" className="text-lg font-semibold">
        Review: {rec.context.datasets.A.fileName} and {rec.context.datasets.B.fileName}
      </h2>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Summary">
        <Count label="Matched pairs" value={counts.matched} />
        <Count label="Needs review" value={counts.needsReview} />
        <Count label="Unresolved in A" value={counts.unresolvedA} />
        <Count label="Unresolved in B" value={counts.unresolvedB} />
        <Count label="Quantity differences" value={counts.quantityDifferences} />
      </dl>
      <p className="text-sm">
        Counts overlap: a matched pair can also have a quantity difference. Matching decides that two records are the same product;
        their quantities can still disagree.
      </p>

      <AnalysisPanel ai={ai} />

      <div role="group" aria-label="Filter records" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`btn ${filter === f.id ? "btn-primary" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="relative overflow-x-auto">
          <table className="data-table w-full min-w-[640px] text-sm">
            <caption className="sr-only">Records in original order</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Source A product</th>
                <th scope="col">Source B product</th>
                <th scope="col">Qty A</th>
                <th scope="col">Qty B</th>
                <th scope="col">Difference (B − A)</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <Row key={row.key} row={row} rec={rec} selected={row.key === selected} onSelect={() => setSelected(row.key)} />
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7}>No records match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          {selectedRow ? (
            <RecordDetail row={selectedRow} workflow={workflow} />
          ) : (
            <p>Select a record to see its source values, evidence and actions.</p>
          )}
        </div>
      </div>

      <div>
        <button type="button" className="btn btn-primary" disabled={!view.canExport} onClick={() => dispatch({ type: "stage/navigated", stage: "export" })}>
          Continue to export
        </button>
        {!view.canExport && <p className="text-sm">Export is available once the analysis run ends or is cancelled.</p>}
      </div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border p-2">
      <dt className="text-sm">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

function Row({ row, rec, selected, onSelect }: { row: ReviewRow; rec: NonNullable<Workflow["state"]["reconciliation"]>; selected: boolean; onSelect: () => void }) {
  let a = "—";
  let b = "—";
  let qa = "—";
  let qb = "—";
  let diff = "";
  if (row.kind === "unresolved") {
    const f = recordFields(rec, row.key);
    if (row.side === "A") [a, qa] = [describe(rec, row.key), f.quantity];
    else [b, qb] = [describe(rec, row.key), f.quantity];
  } else {
    const rightId = row.kind === "pair" ? row.pair.rightId : row.proposal.rightId;
    a = describe(rec, row.key);
    b = row.kind === "pending" ? `${describe(rec, rightId)} (suggested)` : describe(rec, rightId);
    qa = row.comparison.leftRaw;
    qb = row.comparison.rightRaw;
    diff = row.comparison.delta ?? COMPARISON_LABEL[row.comparison.status];
  }
  const differs = row.kind !== "unresolved" && row.comparison.status === "different";
  return (
    <tr className={selected ? "bg-blue-50 dark:bg-blue-950" : undefined}>
      <td>
        {statusLabel(row)}
        {differs && <span className="block">Quantity differs</span>}
      </td>
      <td>{a}</td>
      <td>{b}</td>
      <td>{qa}</td>
      <td>{qb}</td>
      <td>{diff}</td>
      <td>
        <button type="button" className="btn" aria-pressed={selected} onClick={onSelect}>
          Details<span className="sr-only"> for {row.kind === "unresolved" && row.side === "B" ? b : a}</span>
        </button>
      </td>
    </tr>
  );
}
