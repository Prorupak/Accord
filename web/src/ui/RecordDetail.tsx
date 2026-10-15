"use client";

import { useState } from "react";
import { eligibleRightRows } from "../domain/candidates";
import type { ReconciliationState } from "../domain/reconcile";
import type { DecisionAction, Proposal, RowId } from "../domain/types";
import type { Workflow } from "./AccordApp";
import { describe, recordFields } from "./recordFields";
import { COMPARISON_LABEL, statusLabel, type ReviewRow } from "./reviewRows";

const METHOD_TEXT = {
  exact_id: "Automatic: both records carry the same unique product ID.",
  ai_reviewed: "AI suggestion approved by you.",
  manual: "Chosen manually by you.",
} as const;

export function RecordDetail({ row, workflow }: { row: ReviewRow; workflow: Workflow }) {
  const rec = workflow.state.reconciliation!;
  const decide = (action: DecisionAction, leftId: RowId, rightId: RowId | null, proposalId: string | null = null) =>
    workflow.decide(action, leftId, rightId, proposalId);
  const leftId = row.kind === "unresolved" && row.side === "B" ? null : row.key;
  const rightId = row.kind === "pair" ? row.pair.rightId : row.kind === "pending" ? row.proposal.rightId : row.side === "B" ? row.key : null;
  // The latest proposal for this Source A record under the current configuration, if any.
  const proposal =
    row.kind === "pending"
      ? row.proposal
      : leftId
        ? [...rec.proposals].reverse().find((p) => p.leftId === leftId && p.configurationHash === rec.context.configurationHash)
        : undefined;

  return (
    <section aria-labelledby="detail-title" className="flex flex-col gap-3 rounded border p-3">
      <h3 id="detail-title" className="font-semibold">
        {statusLabel(row)}
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {leftId && <SourceRecord rec={rec} rowId={leftId} />}
        {rightId && <SourceRecord rec={rec} rowId={rightId} />}
      </div>

      {row.kind === "pair" && <p>Matching method: {METHOD_TEXT[row.pair.method]}</p>}
      {row.kind === "pending" && <p>Matching method: AI suggestion awaiting your review. It is not a verified match.</p>}
      {row.kind !== "unresolved" && (
        <p>
          Quantity: {COMPARISON_LABEL[row.comparison.status]}
          {row.comparison.delta !== null && ` (B − A = ${row.comparison.delta})`}
        </p>
      )}
      {row.kind === "pending" && <p>Eligibility: neither record is quarantined and their product IDs do not conflict.</p>}
      {row.kind === "unresolved" && <p>Why unresolved: {row.unresolved.detail}</p>}

      {proposal && <ProposalEvidence rec={rec} proposal={proposal} />}

      <div className="flex flex-wrap gap-2">
        {row.kind === "pair" && row.pair.method === "exact_id" && (
          <button type="button" className="btn" onClick={() => decide("exclude_exact", row.pair.leftId, row.pair.rightId)}>
            Exclude ID match
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
        {leftId && row.kind === "unresolved" && <UndoButtons rec={rec} leftId={leftId} decide={decide} />}
      </div>

      {leftId && row.kind !== "pair" && <CandidatePicker key={leftId} rec={rec} leftId={leftId} onPick={(r) => decide("accept", leftId, r)} />}
      {row.kind === "unresolved" && row.side === "B" && (
        <>
          <p className="text-sm">To pair this record, open the Source A record it belongs to and choose it there.</p>
          <UndoButtons rec={rec} rightId={row.key} decide={decide} />
        </>
      )}
    </section>
  );
}

function SourceRecord({ rec, rowId }: { rec: ReconciliationState; rowId: RowId }) {
  const f = recordFields(rec, rowId);
  const m = rec.context.configuration[f.side];
  const role = (id: string) =>
    id === m.productId ? " (product ID)" : id === m.name ? " (name)" : id === m.quantity ? " (quantity)" : id === m.unit ? " (unit)" : "";
  return (
    <div>
      <h4 className="font-semibold">
        Source {f.side}, record {f.row.index + 1}
      </h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        {f.dataset.columns.map((c) => (
          <div key={c.id} className="contents">
            <dt>
              {c.header}
              {role(c.id)}
            </dt>
            <dd className="break-words">{f.row.cells[c.index] === "" ? "(blank)" : f.row.cells[c.index]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ProposalEvidence({ rec, proposal }: { rec: ReconciliationState; proposal: Proposal }) {
  const header = (side: "A" | "B", columnId: string) => rec.context.datasets[side].columns.find((c) => c.id === columnId)?.header ?? columnId;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="font-semibold">AI output</h4>
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
    <div className="flex flex-col gap-2 border-t pt-2">
      <h4 className="font-semibold">Choose another record</h4>
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
          <input id={inputId} type="search" className="rounded border p-1" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="flex flex-col gap-1">
            {shown.map((id) => (
              <li key={id}>
                <button type="button" className="btn w-full text-left" onClick={() => onPick(id)}>
                  Pair with {describe(rec, id)}, qty {recordFields(rec, id).quantity || "(blank)"}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="text-sm">No eligible record matches “{query}”.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
