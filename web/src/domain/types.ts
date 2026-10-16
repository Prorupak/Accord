// Domain contracts from spec §6, §9 and §10. Everything here is plain data so it can be
// frozen, serialized into audit.json and replayed without the code that produced it.

export const PARSER_POLICY_VERSION = 1;
export const MATCHING_POLICY_VERSION = 1;
export const EXPORT_POLICY_VERSION = 1;

// §2.1 fixed operating limits.
export const LIMITS = {
  maxFileBytes: 262_144,
  minRecords: 1,
  maxRecords: 200,
  minColumns: 2,
  maxColumns: 12,
  maxCellCodePoints: 2_048,
  maxCandidates: 5,
  maxAnalysisRows: 20,
} as const;

export type Side = "A" | "B";
export type ColumnId = string;
export type RowId = string;

export type Column = { readonly id: ColumnId; readonly index: number; readonly header: string };
export type Row = { readonly id: RowId; readonly index: number; readonly cells: readonly string[] };

export type Dataset = {
  readonly side: Side;
  readonly id: string; // sha256 of the original file bytes
  readonly fileName: string;
  readonly byteLength: number;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  readonly parse: { readonly policyVersion: 1; readonly ignoredBlankRecords: number };
};

export type Mapping = {
  readonly productId: ColumnId | null;
  readonly name: ColumnId;
  readonly quantity: ColumnId;
  readonly unit: ColumnId | null;
};

export type Configuration = {
  readonly A: Mapping;
  readonly B: Mapping;
  readonly idCaseSensitive: boolean;
  readonly sharedQuantityUnitConfirmed: boolean;
  readonly matchingPolicyVersion: 1;
};

export type EvidenceRef = {
  readonly side: Side;
  readonly rowId: RowId;
  readonly columnId: ColumnId;
  readonly value: string;
};

export type ProposalOutcome = "suggest" | "abstain";
export type ProposalReason = "semantic_equivalence" | "ambiguous" | "insufficient_evidence";

export type Proposal = {
  readonly id: string; // assigned by the app, never trusted from the model
  readonly generation: number;
  readonly configurationHash: string;
  readonly leftId: RowId;
  readonly rightId: RowId | null;
  readonly outcome: ProposalOutcome;
  readonly reasonCode: ProposalReason;
  readonly evidence: readonly EvidenceRef[];
  readonly explanation: string;
};

export type PairMethod = "exact_id" | "ai_reviewed" | "manual";

export type Pair = {
  readonly id: string;
  readonly leftId: RowId;
  readonly rightId: RowId;
  readonly configurationHash: string;
  readonly method: PairMethod;
  readonly decisionId: string | null;
  readonly proposalId: string | null;
};

export type DecisionAction = "accept" | "reject" | "defer" | "undo" | "exclude_exact";

export type UserDecision = {
  readonly id: string;
  readonly action: DecisionAction;
  readonly leftId: RowId;
  readonly rightId: RowId | null;
  readonly proposalId: string | null;
  readonly configurationHash: string;
  readonly at: string;
};

export type ComparisonStatus = "equal" | "different" | "invalid" | "unit_mismatch" | "unit_unknown";

export type Comparison = {
  readonly status: ComparisonStatus;
  readonly leftRaw: string;
  readonly rightRaw: string;
  readonly delta: string | null;
};

export type UnresolvedReason =
  | "duplicate_id"
  | "conflicting_id"
  | "missing_name"
  | "no_candidates"
  | "ambiguous"
  | "rejected"
  | "deferred"
  | "analysis_limit"
  | "analysis_failed"
  | "analysis_cancelled"
  | "unpaired";

export type TaskStatus = "idle" | "running" | "partial" | "complete" | "cancelled" | "failed";

export type RowPair = { readonly leftId: RowId; readonly rightId: RowId };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
