// Workflow contracts (spec §9). The domain engine owns reconciliation; this layer only adds the
// navigation stage, the datasets and draft mapping that precede confirmation, import tokens and
// a display error. Ownership per field is documented in docs/workflow-state.md.
import type { CanonicalField, DraftConfiguration, MappingError } from "../domain/mapping";
import type { ParseError } from "../domain/parseCsv";
import type { DecisionError, ProposalBatch, ReconciliationState } from "../domain/reconcile";
import type { ColumnId, Configuration, Dataset, RowId, Side, UserDecision } from "../domain/types";

export type Stage = "import" | "mapping" | "review" | "export";

// `pendingToken` names the only in-flight import allowed to commit for this side.
export type ImportSlot = { readonly dataset: Dataset | null; readonly pendingToken: string | null };

export type WorkflowState = {
  readonly stage: Stage;
  readonly sources: { readonly A: ImportSlot; readonly B: ImportSlot };
  readonly draft: DraftConfiguration;
  // Non-null exactly when mappings are confirmed. Owns configuration, hash, generation,
  // revision, pairs, decisions, proposals and the analysis record.
  readonly reconciliation: ReconciliationState | null;
  readonly error: WorkflowError | null;
};

// Identifies one analysis run: the generation and configuration it was started under.
export type RunRef = { readonly generation: number; readonly configurationHash: string };

export type WorkflowAction =
  | { type: "import/started"; side: Side; token: string }
  | { type: "import/succeeded"; side: Side; token: string; dataset: Dataset }
  | { type: "import/failed"; side: Side; token: string; error: ParseError }
  | { type: "source/cleared"; side: Side }
  | { type: "workflow/reset" }
  | { type: "draft/fieldMapped"; side: Side; field: CanonicalField; columnId: ColumnId | null }
  | { type: "draft/optionSet"; option: "idCaseSensitive" | "sharedQuantityUnitConfirmed"; value: boolean }
  | {
      type: "mapping/confirmed";
      datasetIds: { readonly A: string; readonly B: string };
      configuration: Configuration;
      configurationHash: string;
    }
  | { type: "decision/requested"; decision: UserDecision }
  | { type: "analysis/started" }
  | { type: "analysis/batchReceived"; batch: ProposalBatch; rowIds: readonly RowId[] }
  | ({ type: "analysis/batchFailed"; rowIds: readonly RowId[] } & RunRef)
  | ({ type: "analysis/completed" } & RunRef)
  | ({ type: "analysis/cancelled" } & RunRef)
  | ({ type: "analysis/failed"; message: string } & RunRef)
  | { type: "stage/navigated"; stage: Stage }
  | { type: "error/dismissed" };

// User-correctable failures, plus `invalid_transition` for programming errors (an action the
// UI should never have been able to dispatch). Messages never contain source cell values.
export type WorkflowError =
  | { kind: "import_failed"; side: Side; error: ParseError }
  | { kind: "stale_configuration"; message: string }
  | { kind: "invalid_configuration"; errors: MappingError[] }
  | { kind: "missing_prerequisite"; message: string }
  | { kind: "decision_rejected"; error: DecisionError }
  | { kind: "analysis_failed"; message: string }
  | { kind: "invalid_transition"; action: WorkflowAction["type"]; message: string };
