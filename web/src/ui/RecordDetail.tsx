"use client";

import { useRef, useState, type ReactNode } from "react";
import { eligibleRightRows } from "../domain/candidates";
import type { ReconciliationState } from "../domain/reconcile";
import type { DecisionAction, Proposal, RowId } from "../domain/types";
import type { Workflow } from "./AccordApp";
import { describe, recordFields } from "./recordFields";
import { COMPARISON_LABEL, counterpart, statusLabel, statusTone, type ReviewRow, type Tone } from "./reviewRows";

export const TONE_TEXT: Record<Tone, string> = { success: "text-success", review: "text-review", error: "text-error", muted: "text-muted" };
export const TONE_DOT: Record<Tone, string> = { success: "bg-success", review: "bg-review", error: "bg-error", muted: "bg-line-strong" };

export function StatusMark({ row }: { row: ReviewRow }) {
  const tone = statusTone(row);
  return (
    <span className={`inline-flex items-start gap-1.5 text-caption font-medium ${TONE_TEXT[tone]}`}>
      <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      {statusLabel(row)}
    </span>
  );
}

const METHOD_TEXT = {
  exact_id: "Automatic: both records carry the same unique product ID.",
  ai_reviewed: "AI suggestion approved by you.",
  manual: "Chosen manually by you.",
} as const;

export function RecordDetail({ row, workflow, onDecide }: { row: ReviewRow; workflow: Workflow; onDecide: () => void }) {
  const rec = workflow.state.reconciliation!;
  const title = useRef<HTMLHeadingElement>(null);
  // Focus stays in the inspector after a decision; the heading then announces the new state.
  const decide = (action: DecisionAction, leftId: RowId, rightId: RowId | null, proposalId: string | null = null) => {
    onDecide();
    workflow.decide(action, leftId, rightId, proposalId);
    title.current?.focus();
  };
  const leftId = row.kind === "unresolved" && row.side === "B" ? null : row.key;
  const rightId = row.kind === "unresolved" ? (row.side === "B" ? row.key : null) : counterpart(row);
  // The latest proposal for this Source A record under the current configuration, if any.
  const proposal =
    row.kind === "pending"
      ? row.proposal
      : leftId
        ? [...rec.proposals].reverse().find((p) => p.leftId === leftId && p.configurationHash === rec.context.configurationHash)
        : undefined;
  const conflict = row.kind === "unresolved" && (row.unresolved.reason === "duplicate_id" || row.unresolved.reason === "conflicting_id");
  const self = recordFields(rec, row.key);

  return (
    <section aria-labelledby="detail-title" className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-panel">
        <div>
          <p className="text-label uppercase tracking-wide text-muted">
            Record inspector · Source {self.side}, record {self.row.index + 1}
          </p>
          <h2 id="detail-title" ref={title} tabIndex={-1} className="mt-1 text-heading">
            {inspectorTitle(row)}
          </h2>
          <div className="mt-1">
            <StatusMark row={row} />
          </div>
        </div>

        <Section title="Original source values">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SourceRecord rec={rec} rowId={leftId} side="A" />
            <SourceRecord rec={rec} rowId={rightId} side="B" />
          </div>
        </Section>

        {row.kind !== "unresolved" && (
          <Section title="Quantity comparison">
            {row.kind === "pair" ? (
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-dense text-muted">{COMPARISON_LABEL[row.comparison.status]}</p>
                {row.comparison.delta !== null && (
                  <p className={`text-section tabular-nums ${row.comparison.status === "different" ? "text-review" : ""}`}>
                    <span className="sr-only">B − A = </span>
                    {row.comparison.delta}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-dense text-muted">Not compared yet: the difference is calculated once you accept the pair.</p>
            )}
          </Section>
        )}

        <Section title={row.kind === "pending" ? "Interpretation and evidence" : "Matching policy and context"}>
          <Context row={row} rec={rec} conflict={conflict} />
          {proposal && <ProposalEvidence rec={rec} proposal={proposal} />}
        </Section>

        {leftId && row.kind !== "pair" && <CandidatePicker key={leftId} rec={rec} leftId={leftId} onPick={(r) => decide("accept", leftId, r)} />}
      </div>

      <div className="flex flex-wrap gap-2 border-t p-4">
        {row.kind === "pair" && row.pair.method === "exact_id" && (
          <button type="button" className="btn" onClick={() => decide("exclude_exact", row.pair.leftId, row.pair.rightId)}>
            Exclude exact match
          </button>
        )}
        {row.kind === "pair" && row.pair.method !== "exact_id" && (
          <button type="button" className="btn" onClick={() => decide("undo", row.pair.leftId, row.pair.rightId)}>
            Undo match
          </button>
        )}
        {row.kind === "pending" && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => decide("accept", row.key, row.proposal.rightId, row.proposal.id)}>
              Accept pair
            </button>
            <button type="button" className="btn" onClick={() => decide("reject", row.key, row.proposal.rightId, row.proposal.id)}>
              Reject suggestion
            </button>
          </>
        )}
        {leftId && row.kind !== "pair" && (
          <button type="button" className="btn" onClick={() => decide("defer", leftId, null)}>
            Leave unresolved
          </button>
        )}
        {row.kind === "unresolved" && <UndoButtons rec={rec} leftId={leftId ?? undefined} rightId={leftId ? undefined : row.key} decide={decide} />}
        {row.kind === "unresolved" && row.side === "B" && !conflict && (
          <p className="text-dense text-muted">To pair this record, open the Source A record it belongs to and choose it there.</p>
        )}
        {conflict && <p className="text-dense text-muted">Pairing is blocked by the product-ID policy.</p>}
      </div>
    </section>
  );
}

function inspectorTitle(row: ReviewRow): string {
  if (row.kind === "pair") return row.pair.method === "exact_id" ? "Matched by product ID" : "Pair approved by you";
  if (row.kind === "pending") return "Suggested interpretation";
  const reason = row.unresolved.reason;
  if (reason === "duplicate_id" || reason === "conflicting_id") return "Identifier conflict";
  return reason === "ambiguous" ? "Unresolved ambiguity" : "Unresolved record";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t pt-5">
      <h3 className="text-label uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

const SLAB: Record<"calm" | "review" | "error", string> = {
  calm: "border-line bg-canvas",
  review: "border-review bg-review-soft",
  error: "border-error bg-error-soft",
};

function Slab({ tone, title, children }: { tone: keyof typeof SLAB; title: string; children: ReactNode }) {
  return (
    <div className={`border-l-2 px-3 py-2.5 text-dense ${SLAB[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  );
}

function Context({ row, rec, conflict }: { row: ReviewRow; rec: ReconciliationState; conflict: boolean }) {
  if (row.kind === "pair") {
    if (row.pair.method !== "exact_id") return <Slab tone="calm" title="Approved by you">{METHOD_TEXT[row.pair.method]}</Slab>;
    return (
      <Slab tone="calm" title="Matched by product ID">
        Both records carry the unique product ID <code className="break-words">{recordFields(rec, row.key).productId}</code>. Name and quantity
        differences are still shown separately.
      </Slab>
    );
  }
  if (row.kind === "pending")
    return (
      <Slab tone="review" title="A suggestion, not a verified match">
        The AI proposed this counterpart. A suggestion is not proof and reserves nothing: inspect the original values before deciding. Neither
        record is quarantined and their product IDs do not conflict.
      </Slab>
    );
  if (conflict)
    return (
      <Slab tone="error" title={row.unresolved.reason === "duplicate_id" ? "Duplicate product ID quarantined" : "Conflicting product IDs"}>
        {row.unresolved.detail} Accord does not pair around an identifier conflict. Correct the identifier in the source export and import it
        again, or revisit Mapping if the wrong column is mapped as the product ID.
      </Slab>
    );
  if (row.unresolved.reason === "ambiguous")
    return (
      <Slab tone="review" title="The AI did not choose a counterpart">
        {row.unresolved.detail} It abstained rather than guess. You can still choose a record yourself.
      </Slab>
    );
  return <Slab tone="calm" title="No accepted pair">{row.unresolved.detail} Unresolved records stay in the export.</Slab>;
}

function SourceRecord({ rec, rowId, side }: { rec: ReconciliationState; rowId: RowId | null; side: "A" | "B" }) {
  if (!rowId)
    return (
      <div className="flex min-h-24 items-center justify-center rounded-control border border-dashed bg-canvas p-4 text-center text-dense text-muted">
        Not paired with a Source {side} record.
      </div>
    );
  const f = recordFields(rec, rowId);
  const m = rec.context.configuration[f.side];
  const role = (id: string) =>
    id === m.productId ? " (product ID)" : id === m.name ? " (name)" : id === m.quantity ? " (quantity)" : id === m.unit ? " (unit)" : "";
  const shown = (v: string, blank: string) => (v.trim() === "" ? <span className="text-muted">{blank}</span> : v);
  return (
    <div className="min-w-0 rounded-control border p-3">
      <h4 className="text-caption font-semibold uppercase tracking-wide text-muted">Source {side}</h4>
      <p className="mt-1 font-medium break-words">{shown(f.name, "(no name)")}</p>
      <dl className="mt-2 text-dense">
        <Fact label="Product ID">
          {f.productId.trim() === "" ? <span className="text-muted">Not provided</span> : <span className="font-mono break-all">{f.productId}</span>}
        </Fact>
        <Fact label="Quantity">
          {shown(f.quantity, "(blank)")}
          {m.unit && f.unit.trim() !== "" && ` ${f.unit}`}
        </Fact>
        <Fact label="Record">{f.row.index + 1}</Fact>
      </dl>
      <details className="mt-2 text-dense">
        <summary className="cursor-pointer text-muted">All columns</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3">
          {f.dataset.columns.map((c) => (
            <div key={c.id} className="contents">
              <dt className="text-muted">
                {c.header}
                {role(c.id)}
              </dt>
              <dd className="break-words">{f.row.cells[c.index] === "" ? "(blank)" : f.row.cells[c.index]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-t py-1.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  );
}

function ProposalEvidence({ rec, proposal }: { rec: ReconciliationState; proposal: Proposal }) {
  const header = (side: "A" | "B", columnId: string) => rec.context.datasets[side].columns.find((c) => c.id === columnId)?.header ?? columnId;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-dense font-semibold">AI output</h4>
      <p className="text-sm">
        Outcome: {proposal.outcome === "suggest" ? "suggested a pair" : `abstained (${proposal.reasonCode.replace(/_/g, " ")})`}
      </p>
      {proposal.evidence.length > 0 && (
        <ul className="text-sm" aria-label="Cited source values">
          {proposal.evidence.map((e, i) => (
            <li key={i}>
              Source {e.side}, {header(e.side, e.columnId)}: “{e.value}”
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        <strong>Suggested interpretation:</strong> {proposal.explanation}
      </p>
    </div>
  );
}

// Reversible decisions recorded against this record: rejections and excluded ID matches.
function UndoButtons({
  rec,
  leftId,
  rightId,
  decide,
}: {
  rec: ReconciliationState;
  leftId?: RowId;
  rightId?: RowId;
  decide: (action: DecisionAction, leftId: RowId, rightId: RowId | null) => void;
}) {
  const involves = (p: { leftId: RowId; rightId: RowId }) => (leftId ? p.leftId === leftId : p.rightId === rightId);
  const items = [
    ...rec.rejectedPairs.filter(involves).map((p) => ({ ...p, label: "Undo rejection of" })),
    ...rec.excludedExactPairs.filter(involves).map((p) => ({ ...p, label: "Restore ID match with" })),
  ];
  return items.map((p) => (
    <button key={`${p.label}${p.leftId}${p.rightId}`} type="button" className="btn" onClick={() => decide("undo", p.leftId, p.rightId)}>
      {p.label} {describe(rec, leftId ? p.rightId : p.leftId)}
    </button>
  ));
}

function CandidatePicker({ rec, leftId, onPick }: { rec: ReconciliationState; leftId: RowId; onPick: (rightId: RowId) => void }) {
  const [query, setQuery] = useState("");
  const eligible = eligibleRightRows(rec, leftId);
  const q = query.trim().toLowerCase();
  const shown = eligible.filter((id) => describe(rec, id).toLowerCase().includes(q));
  const inputId = `picker-${leftId}`;
  return (
    <section className="flex flex-col gap-2 border-t pt-5">
      <h3 className="text-label uppercase tracking-wide text-muted">Choose another record</h3>
      {eligible.length === 0 ? (
        <p className="text-sm">
          No Source B record can be paired with this record. Records that are already paired, rejected for it, quarantined for a
          duplicate ID, or carry a different product ID are excluded, and a record without a product name can only pair by ID.
        </p>
      ) : (
        <>
          <label htmlFor={inputId} className="text-sm">
            Search eligible Source B records by name or ID ({eligible.length} eligible)
          </label>
          <input id={inputId} type="search" className="w-full" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="flex flex-col gap-1">
            {shown.map((id) => (
              <li key={id}>
                <button type="button" className="btn w-full justify-start text-left" onClick={() => onPick(id)}>
                  Pair with {describe(rec, id)}, qty {recordFields(rec, id).quantity || "(blank)"}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="text-sm">No eligible record matches “{query}”.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
