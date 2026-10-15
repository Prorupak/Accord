import Papa from "papaparse";
import { candidatesFor } from "./candidates";
import { cellOf } from "./eligibility";
import { checkInvariants, type Violation } from "./invariants";
import { compareQuantities } from "./quantity";
import { partition, unresolvedReason, type AnalysisRecord, type ReconciliationState } from "./reconcile";
import {
  EXPORT_POLICY_VERSION,
  MATCHING_POLICY_VERSION,
  PARSER_POLICY_VERSION,
  type Configuration,
  type Dataset,
  type Pair,
  type Proposal,
  type RowId,
  type RowPair,
  type Side,
  type TaskStatus,
  type UnresolvedReason,
  type UserDecision,
} from "./types";

// §10.1 and §10.2 fixed column order.
export const MATCH_FIELDS = [
  "pair_id",
  "match_method",
  "left_row_id",
  "right_row_id",
  "left_product_id",
  "right_product_id",
  "left_name",
  "right_name",
  "left_quantity",
  "right_quantity",
  "left_unit",
  "right_unit",
  "quantity_status",
  "delta_b_minus_a",
  "decision_id",
] as const;

export const UNRESOLVED_FIELDS = [
  "source",
  "row_id",
  "record_index",
  "product_id",
  "name",
  "quantity",
  "unit",
  "reason_code",
  "detail",
] as const;

export type MatchRow = Record<(typeof MATCH_FIELDS)[number], string>;
export type UnresolvedRow = Record<(typeof UNRESOLVED_FIELDS)[number], string>;

export type ModelRun = {
  requestId: string;
  provider: string;
  model: string;
  promptVersion: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  result: "valid" | "failed" | "cancelled";
};

// §10.3. `analysis` adds the three row-ID lists to the spec's counts so replay can rebuild
// analysis-dependent unresolved reasons; everything else matches the spec field for field.
export type AuditV1 = {
  schemaVersion: 1;
  appVersion: string;
  generatedAt: string;
  runId: string;
  revision: number;
  datasets: [Dataset, Dataset];
  configuration: Configuration;
  configurationHash: string;
  acceptedPairs: Pair[];
  decisions: UserDecision[];
  proposals: Proposal[];
  excludedExactPairs: RowPair[];
  unmatched: Array<{ side: Side; rowId: RowId; reason: UnresolvedReason }>;
  analysis: {
    status: TaskStatus;
    analyzedRows: number;
    eligibleRows: number;
    selectedRowIds: RowId[];
    analyzedRowIds: RowId[];
    failedRowIds: RowId[];
  };
  modelRuns: ModelRun[];
  policies: { parser: 1; matching: 1; export: 1 };
  invariants: { passed: true; leftCount: number; rightCount: number; pairCount: number };
};

// Spreadsheet formula triggers (§10.4), also when preceded by whitespace. Tab and CR count as
// triggers themselves. Plain decimal numbers such as "-3" cannot carry a formula and are left
// as-is so negative quantities stay readable.
const FORMULA_TRIGGER = /^(?:[\t\r]|\s*[=+\-@])/u;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

export function protectCell(value: string): string {
  return FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

export function toCsv<F extends string>(fields: readonly F[], rows: ReadonlyArray<Record<F, string>>, raw: ReadonlySet<F> = new Set()): string {
  return Papa.unparse(
    { fields: [...fields], data: rows.map((r) => fields.map((f) => (raw.has(f) ? r[f] : protectCell(r[f])))) },
    { newline: "\r\n", header: true, escapeFormulae: false },
  );
}

// Canonical projections, recomputed from immutable source cells and current settings.
export function canonicalRows(state: ReconciliationState): { matches: MatchRow[]; unresolved: UnresolvedRow[] } {
  const ctx = state.context;
  const cell = (side: Side, rowId: RowId, field: "productId" | "name" | "quantity" | "unit") =>
    cellOf(ctx.datasets[side], ctx.rows.get(rowId)!.row, ctx.configuration[side][field]);
  const { pairs, unmatchedA, unmatchedB } = partition(state);

  const matches = pairs.map((p): MatchRow => {
    const q = compareQuantities(ctx, p.leftId, p.rightId);
    return {
      pair_id: p.id,
      match_method: p.method,
      left_row_id: p.leftId,
      right_row_id: p.rightId,
      left_product_id: cell("A", p.leftId, "productId"),
      right_product_id: cell("B", p.rightId, "productId"),
      left_name: cell("A", p.leftId, "name"),
      right_name: cell("B", p.rightId, "name"),
      left_quantity: q.leftRaw,
      right_quantity: q.rightRaw,
      left_unit: cell("A", p.leftId, "unit"),
      right_unit: cell("B", p.rightId, "unit"),
      quantity_status: q.status,
      delta_b_minus_a: q.delta ?? "",
      decision_id: p.decisionId ?? "",
    };
  });

  const unresolved = [...unmatchedA, ...unmatchedB].map((rowId): UnresolvedRow => {
    const info = ctx.rows.get(rowId)!;
    const { reason, detail } = unresolvedReason(state, rowId);
    return {
      source: info.side,
      row_id: rowId,
      record_index: String(info.row.index),
      product_id: cell(info.side, rowId, "productId"),
      name: cell(info.side, rowId, "name"),
      quantity: cell(info.side, rowId, "quantity"),
      unit: cell(info.side, rowId, "unit"),
      reason_code: reason,
      detail,
    };
  });
  return { matches, unresolved };
}

// Source A rows that retrieval could send for AI review right now.
export function analysisEligibleRows(state: ReconciliationState): RowId[] {
  return partition(state).unmatchedA.filter((id) => candidatesFor(state, id).length > 0);
}

export function analysisSummary(state: ReconciliationState): AuditV1["analysis"] {
  const a: AnalysisRecord = state.analysis;
  return {
    status: a.status,
    analyzedRows: a.analyzedRowIds.length,
    eligibleRows: analysisEligibleRows(state).length,
    selectedRowIds: [...a.selectedRowIds],
    analyzedRowIds: [...a.analyzedRowIds],
    failedRowIds: [...a.failedRowIds],
  };
}

export const MATCHES_RAW_FIELDS: ReadonlySet<(typeof MATCH_FIELDS)[number]> = new Set(["delta_b_minus_a"]);

export type ExportMeta = { appVersion: string; generatedAt: string; runId: string; modelRuns?: ModelRun[] };

export type ExportSnapshot = {
  readonly revision: number;
  readonly configurationHash: string;
  readonly matches: readonly MatchRow[];
  readonly unresolved: readonly UnresolvedRow[];
  readonly audit: AuditV1;
  readonly files: { readonly "matches.csv": string; readonly "unresolved.csv": string; readonly "audit.json": string };
};

export type ExportResult = { ok: true; snapshot: ExportSnapshot } | { ok: false; violations: Violation[] };

// §3.4 / §10: freeze one revision, verify invariants, then build all three artifacts from that
// same state. On any invariant failure nothing is produced.
export function prepareExport(state: ReconciliationState, meta: ExportMeta): ExportResult {
  const report = checkInvariants(state);
  if (!report.ok) return { ok: false, violations: report.violations };

  const ctx = state.context;
  const { matches, unresolved } = canonicalRows(state);
  const { unmatchedA, unmatchedB } = partition(state);
  const audit: AuditV1 = {
    schemaVersion: 1,
    appVersion: meta.appVersion,
    generatedAt: meta.generatedAt,
    runId: meta.runId,
    revision: state.revision,
    datasets: [ctx.datasets.A, ctx.datasets.B],
    configuration: ctx.configuration,
    configurationHash: ctx.configurationHash,
    acceptedPairs: [...state.acceptedPairs],
    decisions: [...state.decisions],
    proposals: [...state.proposals],
    excludedExactPairs: [...state.excludedExactPairs],
    unmatched: [...unmatchedA, ...unmatchedB].map((rowId) => ({
      side: ctx.rows.get(rowId)!.side,
      rowId,
      reason: unresolvedReason(state, rowId).reason,
    })),
    analysis: analysisSummary(state),
    modelRuns: meta.modelRuns ?? [],
    policies: { parser: PARSER_POLICY_VERSION, matching: MATCHING_POLICY_VERSION, export: EXPORT_POLICY_VERSION },
    invariants: { passed: true, ...report.counts },
  };
  return {
    ok: true,
    snapshot: Object.freeze({
      revision: state.revision,
      configurationHash: ctx.configurationHash,
      matches,
      unresolved,
      audit,
      files: Object.freeze({
        "matches.csv": toCsv(MATCH_FIELDS, matches, MATCHES_RAW_FIELDS),
        "unresolved.csv": toCsv(UNRESOLVED_FIELDS, unresolved),
        "audit.json": JSON.stringify(audit, null, 2),
      }),
    }),
  };
}

// Any edit after preparing an export invalidates it (§9 "Edit after export").
export function isSnapshotCurrent(state: ReconciliationState, snapshot: ExportSnapshot): boolean {
  return snapshot.revision === state.revision && snapshot.configurationHash === state.context.configurationHash;
}
