import { identityContextTruncated, projectContext } from "./aiContext";
import { blockedByIdConflict, candidatesFor } from "./candidates";
import {
  checkIdentity,
  checkPair,
  hasPair,
  pairedRows,
  type EligibilityFailure,
  type PairLedger,
  type ReconciliationContext,
} from "./eligibility";
import type { EvidenceRef, Pair, Proposal, RowId, RowPair, TaskStatus, UnresolvedReason, UserDecision } from "./types";

// Minimum analysis bookkeeping needed to explain unresolved rows (§6 reason codes). The async
// pass that fills it belongs to the workflow reducer.
export type AnalysisRecord = {
  readonly status: TaskStatus;
  readonly selectedRowIds: readonly RowId[];
  readonly analyzedRowIds: readonly RowId[];
  readonly failedRowIds: readonly RowId[];
};

// Authoritative state. Counts, partitions, comparisons, reasons and proposal statuses are
// derived by the selectors below and never stored.
export type ReconciliationState = PairLedger & {
  readonly context: ReconciliationContext;
  readonly revision: number;
  readonly generation: number;
  readonly decisions: readonly UserDecision[];
  readonly proposals: readonly Proposal[];
  readonly analysis: AnalysisRecord;
};

export const exactPairId = (leftId: RowId, rightId: RowId) => `exact:${leftId}:${rightId}`;
export const decisionPairId = (decisionId: string) => `decision:${decisionId}`;
export const proposalIdOf = (requestId: string, leftId: RowId) => `${requestId}:${leftId}`;

function exactPair(ctx: ReconciliationContext, leftId: RowId, rightId: RowId): Pair {
  return {
    id: exactPairId(leftId, rightId),
    leftId,
    rightId,
    configurationHash: ctx.configurationHash,
    method: "exact_id",
    decisionId: null,
    proposalId: null,
  };
}

// Confirming mappings computes the exact-ID pairs (§9). Only unique, nonempty, identical
// normalized IDs pair; quarantined rows never do.
export function initializeState(ctx: ReconciliationContext): ReconciliationState {
  const bById = new Map<string, RowId>();
  for (const row of ctx.datasets.B.rows) {
    const id = ctx.rows.get(row.id)!.normalizedId;
    if (id !== "" && !ctx.quarantined.has(row.id)) bById.set(id, row.id);
  }
  const empty: PairLedger = { acceptedPairs: [], rejectedPairs: [], excludedExactPairs: [] };
  const acceptedPairs: Pair[] = [];
  for (const row of ctx.datasets.A.rows) {
    const rightId = bById.get(ctx.rows.get(row.id)!.normalizedId);
    if (rightId && checkPair(ctx, empty, row.id, rightId, "exact_id").ok) acceptedPairs.push(exactPair(ctx, row.id, rightId));
  }
  return {
    context: ctx,
    revision: 0,
    generation: 0,
    acceptedPairs,
    rejectedPairs: [],
    excludedExactPairs: [],
    decisions: [],
    proposals: [],
    analysis: { status: "idle", selectedRowIds: [], analyzedRowIds: [], failedRowIds: [] },
  };
}

// ---- decisions ----

export type DecisionErrorCode =
  | EligibilityFailure
  | "stale_configuration"
  | "decision_id_conflict"
  | "missing_right"
  | "unknown_proposal"
  | "proposal_mismatch"
  | "already_paired"
  | "not_exact_pair"
  | "nothing_to_undo";

export type DecisionError = { code: DecisionErrorCode; message: string };

export type DecisionResult =
  | { ok: true; state: ReconciliationState; changed: boolean }
  | { ok: false; state: ReconciliationState; error: DecisionError };

const MESSAGES: Partial<Record<DecisionErrorCode, string>> = {
  stale_configuration: "This action was made against an earlier mapping configuration.",
  decision_id_conflict: "This action ID was already used for a different action.",
  missing_right: "Choose a Source B record for this action.",
  unknown_proposal: "That suggestion no longer exists.",
  proposal_mismatch: "That suggestion does not match the selected records or configuration.",
  already_paired: "These records are already paired.",
  not_exact_pair: "Only a current product-ID match can be excluded.",
  nothing_to_undo: "There is no accepted pair, exclusion or rejection to undo for these records.",
};

const sameDecision = (a: UserDecision, b: UserDecision) =>
  a.action === b.action &&
  a.leftId === b.leftId &&
  a.rightId === b.rightId &&
  a.proposalId === b.proposalId &&
  a.configurationHash === b.configurationHash;

const samePair = (p: RowPair, leftId: RowId, rightId: RowId) => p.leftId === leftId && p.rightId === rightId;

// Every human action goes through here. Each check runs against current state, so a stale
// button, a double click or a late model result cannot break one-to-one pairing. A failed
// action returns the same state object, unchanged.
export function applyDecision(state: ReconciliationState, d: UserDecision): DecisionResult {
  const fail = (code: DecisionErrorCode, message = MESSAGES[code]!): DecisionResult => ({
    ok: false,
    state,
    error: { code, message },
  });
  const ctx = state.context;

  const prior = state.decisions.find((x) => x.id === d.id);
  if (prior) return sameDecision(prior, d) ? { ok: true, state, changed: false } : fail("decision_id_conflict");
  if (d.configurationHash !== ctx.configurationHash) return fail("stale_configuration");

  const commit = (patch: Partial<ReconciliationState>): DecisionResult => ({
    ok: true,
    changed: true,
    state: { ...state, ...patch, decisions: [...state.decisions, d], revision: state.revision + 1 },
  });
  const eligible = (rightId: RowId) => checkPair(ctx, state, d.leftId, rightId, "semantic");

  switch (d.action) {
    case "accept": {
      if (d.rightId === null) return fail("missing_right");
      const rightId = d.rightId;
      if (d.proposalId !== null) {
        const p = state.proposals.find((x) => x.id === d.proposalId);
        if (!p) return fail("unknown_proposal");
        if (p.configurationHash !== ctx.configurationHash || p.outcome !== "suggest" || !samePair({ leftId: p.leftId, rightId: p.rightId ?? "" }, d.leftId, rightId))
          return fail("proposal_mismatch");
      }
      if (state.acceptedPairs.some((p) => samePair(p, d.leftId, rightId))) return fail("already_paired");
      const e = eligible(rightId);
      if (!e.ok) return fail(e.reason, e.message);
      const pair: Pair = {
        id: decisionPairId(d.id),
        leftId: d.leftId,
        rightId,
        configurationHash: ctx.configurationHash,
        method: d.proposalId !== null ? "ai_reviewed" : "manual",
        decisionId: d.id,
        proposalId: d.proposalId,
      };
      return commit({ acceptedPairs: [...state.acceptedPairs, pair] });
    }
    case "reject": {
      if (d.rightId === null) return fail("missing_right");
      if (d.proposalId !== null && !state.proposals.some((p) => p.id === d.proposalId && p.leftId === d.leftId && p.rightId === d.rightId))
        return fail("proposal_mismatch");
      const e = eligible(d.rightId);
      if (!e.ok) return fail(e.reason, e.message);
      return commit({ rejectedPairs: [...state.rejectedPairs, { leftId: d.leftId, rightId: d.rightId }] });
    }
    case "defer": {
      const left = ctx.rows.get(d.leftId);
      if (!left) return fail("unknown_row", "This record does not exist in the current datasets.");
      if (left.side !== "A") return fail("wrong_side", "Only Source A records can be deferred.");
      if (pairedRows(state.acceptedPairs).has(d.leftId)) return fail("unavailable", "This record is already in an accepted pair.");
      return commit({});
    }
    case "exclude_exact": {
      const pair = state.acceptedPairs.find((p) => p.method === "exact_id" && samePair(p, d.leftId, d.rightId ?? ""));
      if (!pair) return fail("not_exact_pair");
      return commit({
        acceptedPairs: state.acceptedPairs.filter((p) => p !== pair),
        excludedExactPairs: [...state.excludedExactPairs, { leftId: pair.leftId, rightId: pair.rightId }],
      });
    }
    case "undo": {
      if (d.rightId === null) return fail("missing_right");
      const rightId = d.rightId;
      const accepted = state.acceptedPairs.find((p) => p.method !== "exact_id" && samePair(p, d.leftId, rightId));
      if (accepted) return commit({ acceptedPairs: state.acceptedPairs.filter((p) => p !== accepted) });
      if (hasPair(state.excludedExactPairs, d.leftId, rightId)) {
        const ledger = { ...state, excludedExactPairs: state.excludedExactPairs.filter((p) => !samePair(p, d.leftId, rightId)) };
        const e = checkPair(ctx, ledger, d.leftId, rightId, "exact_id");
        if (!e.ok) return fail(e.reason, e.message);
        return commit({ excludedExactPairs: ledger.excludedExactPairs, acceptedPairs: [...state.acceptedPairs, exactPair(ctx, d.leftId, rightId)] });
      }
      if (hasPair(state.rejectedPairs, d.leftId, rightId))
        return commit({ rejectedPairs: state.rejectedPairs.filter((p) => !samePair(p, d.leftId, rightId)) });
      return fail("nothing_to_undo");
    }
  }
}

// ---- proposals and analysis ----

export type IncomingProposal = Omit<Proposal, "id" | "generation" | "configurationHash">;

export type ProposalBatch = {
  requestId: string;
  generation: number;
  configurationHash: string;
  proposals: readonly IncomingProposal[];
};

export type ProposalRejection = {
  leftId: string;
  reason: "unknown_row" | "duplicate_result" | "invalid_target" | "invalid_evidence" | "truncated_context";
};

export type ProposalIntake = {
  state: ReconciliationState;
  stale: boolean;
  added: number;
  dropped: ProposalRejection[];
};

// Client-side re-validation of /api/suggest output against original application state (§5.2).
// A batch from an old generation or configuration is ignored entirely. Valid proposals replace
// earlier proposals for the same rows unless a decision references them. Availability is not
// checked here: suggestions reserve nothing, and proposalStatus() reports conflicts.
export function addProposals(state: ReconciliationState, batch: ProposalBatch): ProposalIntake {
  const ctx = state.context;
  if (batch.generation !== state.generation || batch.configurationHash !== ctx.configurationHash)
    return { state, stale: true, added: 0, dropped: [] };

  const dropped: ProposalRejection[] = [];
  const accepted: Proposal[] = [];
  const seen = new Set<string>();
  for (const p of batch.proposals) {
    const reason = seen.has(p.leftId) ? "duplicate_result" : proposalDefect(ctx, p);
    seen.add(p.leftId);
    if (reason) dropped.push({ leftId: p.leftId, reason });
    else accepted.push({ ...p, id: proposalIdOf(batch.requestId, p.leftId), generation: batch.generation, configurationHash: batch.configurationHash });
  }

  // A proposal ID already present is a replay of the same request, not a replacement.
  const existing = new Set(state.proposals.map((p) => p.id));
  const fresh = accepted.filter((p) => !existing.has(p.id));
  const referenced = new Set(state.decisions.map((d) => d.proposalId));
  const replaced = new Set(fresh.map((p) => p.leftId));
  const kept = state.proposals.filter((p) => referenced.has(p.id) || !replaced.has(p.leftId));
  return {
    state: fresh.length > 0 ? { ...state, proposals: [...kept, ...fresh], revision: state.revision + 1 } : state,
    stale: false,
    added: fresh.length,
    dropped,
  };
}

// Static checks on one proposal: real Source A row, a policy-eligible target for a suggestion
// (none for an abstention), and evidence citing real cells with values equal to what the model
// was shown: the §7.4 projection, which is the whole cell unless it was clipped.
export function proposalDefect(ctx: ReconciliationContext, p: IncomingProposal): ProposalRejection["reason"] | null {
  const left = ctx.rows.get(p.leftId);
  if (!left || left.side !== "A") return "unknown_row";
  const targetOk =
    p.outcome === "suggest" ? p.rightId !== null && checkIdentity(ctx, p.leftId, p.rightId, "semantic").ok : p.rightId === null;
  if (!targetOk) return "invalid_target";

  // A suggestion cites only its own two rows. An abstention may also cite any Source B row
  // (e.g. the competing candidates of an ambiguous row); it reserves and asserts nothing.
  const owns = (ref: EvidenceRef) =>
    ref.side === "A" ? ref.rowId === p.leftId : p.outcome === "abstain" ? ctx.rows.get(ref.rowId)?.side === "B" : ref.rowId === p.rightId;
  const sides = new Set<string>();
  for (const ref of p.evidence) {
    if (!owns(ref)) return "invalid_evidence";
    const column = ctx.datasets[ref.side].columns.find((c) => c.id === ref.columnId);
    if (!column || projectContext(ctx.rows.get(ref.rowId)!.row.cells[column.index]) !== ref.value) return "invalid_evidence";
    sides.add(ref.side);
  }
  // A suggestion needs supporting evidence from both sides (§6).
  if (p.outcome === "suggest" && !(sides.has("A") && sides.has("B"))) return "invalid_evidence";
  // §7.4 fail closed: if either row's identity text was clipped, the hidden part could change the
  // product, so the suggestion is not actionable. Manual review stays available.
  if (p.outcome === "suggest" && (identityContextTruncated(ctx, p.leftId) || identityContextTruncated(ctx, p.rightId!)))
    return "truncated_context";
  return null;
}

// Starting or cancelling an analysis pass advances the generation so late results are ignored.
export function nextGeneration(state: ReconciliationState): ReconciliationState {
  return { ...state, generation: state.generation + 1 };
}

export function recordAnalysis(
  state: ReconciliationState,
  generation: number,
  configurationHash: string,
  analysis: AnalysisRecord,
): ReconciliationState {
  if (generation !== state.generation || configurationHash !== state.context.configurationHash) return state;
  return { ...state, analysis, revision: state.revision + 1 };
}

// ---- selectors ----

export type ProposalStatus = "pending" | "accepted" | "rejected" | "unavailable" | "abstained" | "stale";

export function proposalStatus(state: ReconciliationState, p: Proposal): ProposalStatus {
  if (p.configurationHash !== state.context.configurationHash) return "stale";
  if (p.outcome === "abstain" || p.rightId === null) return "abstained";
  if (state.acceptedPairs.some((x) => x.proposalId === p.id)) return "accepted";
  if (hasPair(state.rejectedPairs, p.leftId, p.rightId)) return "rejected";
  return checkPair(state.context, state, p.leftId, p.rightId, "semantic").ok ? "pending" : "unavailable";
}

export function pendingProposals(state: ReconciliationState): Proposal[] {
  return state.proposals.filter((p) => proposalStatus(state, p) === "pending");
}

export type Partition = {
  readonly pairs: readonly Pair[]; // ordered by Source A record index
  readonly unmatchedA: readonly RowId[]; // original order
  readonly unmatchedB: readonly RowId[];
};

export function partition(state: ReconciliationState): Partition {
  const { A, B } = state.context.datasets;
  const used = pairedRows(state.acceptedPairs);
  const indexOf = (id: RowId) => state.context.rows.get(id)?.row.index ?? Number.MAX_SAFE_INTEGER;
  return {
    pairs: [...state.acceptedPairs].sort((x, y) => indexOf(x.leftId) - indexOf(y.leftId)),
    unmatchedA: A.rows.filter((r) => !used.has(r.id)).map((r) => r.id),
    unmatchedB: B.rows.filter((r) => !used.has(r.id)).map((r) => r.id),
  };
}

export type Unresolved = { reason: UnresolvedReason; detail: string };

// One primary reason per unmatched row, priority from §6:
// conflict → explicit user decision → analysis outcome → unpaired.
export function unresolvedReason(state: ReconciliationState, rowId: RowId): Unresolved {
  const ctx = state.context;
  const info = ctx.rows.get(rowId)!;
  const r = (reason: UnresolvedReason, detail: string): Unresolved => ({ reason, detail });

  if (ctx.quarantined.has(rowId)) return r("duplicate_id", "Product ID appears more than once; no automatic or manual pairing.");
  if (info.name.trim() === "") return r("missing_name", "No product name and no unique product-ID match.");

  const excluded = state.excludedExactPairs.some((p) => p.leftId === rowId || p.rightId === rowId);
  if (info.side === "B") {
    if (excluded) return r("rejected", "Product-ID match excluded by the user.");
    return r("unpaired", "Not paired with a Source A record.");
  }

  const candidates = candidatesFor(state, rowId);
  if (candidates.length === 0 && blockedByIdConflict(state, rowId))
    return r("conflicting_id", "Similar Source B records carry a different product ID.");

  const latest = [...state.decisions].reverse().find((d) => d.leftId === rowId);
  if (latest?.action === "defer") return r("deferred", "Left unresolved by the user.");
  if (excluded) return r("rejected", "Product-ID match excluded by the user.");
  if (state.rejectedPairs.some((p) => p.leftId === rowId)) return r("rejected", "Suggested pair rejected by the user.");

  const proposal = [...state.proposals].reverse().find((p) => p.leftId === rowId && p.configurationHash === ctx.configurationHash);
  if (proposal?.outcome === "abstain" && proposal.reasonCode === "ambiguous")
    return r("ambiguous", "More than one candidate is plausible.");
  if (state.analysis.failedRowIds.includes(rowId)) return r("analysis_failed", "Analysis could not produce a verified suggestion.");
  // A row with nothing to retrieve could not have been analyzed, whatever happened to the run.
  if (candidates.length === 0) return r("no_candidates", "No Source B record shares name words; use manual selection.");
  const selected = state.analysis.selectedRowIds.includes(rowId);
  if (selected && !state.analysis.analyzedRowIds.includes(rowId) && state.analysis.status === "cancelled")
    return r("analysis_cancelled", "Analysis was cancelled before this record was reviewed.");
  if (selected && !state.analysis.analyzedRowIds.includes(rowId) && state.analysis.status === "failed")
    return r("analysis_failed", "Analysis stopped before this record was reviewed.");
  if (!selected && state.analysis.status !== "idle")
    return r("analysis_limit", "Outside the per-pass AI review limit; manual review is available.");
  if (proposal?.outcome === "suggest") return r("unpaired", "Suggested pair awaiting review.");
  if (proposal?.outcome === "abstain") return r("unpaired", "Model abstained: insufficient evidence.");
  return r("unpaired", "Not paired with a Source B record.");
}
