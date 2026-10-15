import { z } from "zod";
import { buildContext } from "./eligibility";
import {
  analysisSummary,
  canonicalRows,
  MATCH_FIELDS,
  MATCHES_RAW_FIELDS,
  toCsv,
  UNRESOLVED_FIELDS,
  type AuditV1,
  type MatchRow,
  type UnresolvedRow,
} from "./exportSnapshot";
import { rowIdOf } from "./identity";
import { checkInvariants } from "./invariants";
import { configurationHash, validateConfiguration } from "./mapping";
import { applyDecision, initializeState, partition, proposalDefect, unresolvedReason, type ReconciliationState } from "./reconcile";
import { LIMITS } from "./types";

const side = z.enum(["A", "B"]);
const nullableId = z.string().nullable();

const datasetSchema = z.strictObject({
  side,
  id: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string(),
  byteLength: z.number().int().min(1).max(LIMITS.maxFileBytes),
  columns: z.array(z.strictObject({ id: z.string(), index: z.number().int(), header: z.string() })).min(LIMITS.minColumns).max(LIMITS.maxColumns),
  rows: z.array(z.strictObject({ id: z.string(), index: z.number().int(), cells: z.array(z.string()) })).min(LIMITS.minRecords).max(LIMITS.maxRecords),
  parse: z.strictObject({ policyVersion: z.literal(1), ignoredBlankRecords: z.number().int().min(0) }),
});

const mappingSchema = z.strictObject({ productId: nullableId, name: z.string(), quantity: z.string(), unit: nullableId });
const rowPairSchema = z.strictObject({ leftId: z.string(), rightId: z.string() });
const evidenceSchema = z.strictObject({ side, rowId: z.string(), columnId: z.string(), value: z.string() });

const auditSchema = z.strictObject({
  schemaVersion: z.literal(1),
  appVersion: z.string(),
  generatedAt: z.string(),
  runId: z.string(),
  revision: z.number().int().min(0),
  datasets: z.tuple([datasetSchema, datasetSchema]),
  configuration: z.strictObject({
    A: mappingSchema,
    B: mappingSchema,
    idCaseSensitive: z.boolean(),
    sharedQuantityUnitConfirmed: z.boolean(),
    matchingPolicyVersion: z.literal(1),
  }),
  configurationHash: z.string(),
  acceptedPairs: z.array(
    z.strictObject({
      id: z.string(),
      leftId: z.string(),
      rightId: z.string(),
      configurationHash: z.string(),
      method: z.enum(["exact_id", "ai_reviewed", "manual"]),
      decisionId: nullableId,
      proposalId: nullableId,
    }),
  ),
  decisions: z.array(
    z.strictObject({
      id: z.string(),
      action: z.enum(["accept", "reject", "defer", "undo", "exclude_exact"]),
      leftId: z.string(),
      rightId: nullableId,
      proposalId: nullableId,
      configurationHash: z.string(),
      at: z.string(),
    }),
  ),
  proposals: z.array(
    z.strictObject({
      id: z.string(),
      generation: z.number().int().min(0),
      configurationHash: z.string(),
      leftId: z.string(),
      rightId: nullableId,
      outcome: z.enum(["suggest", "abstain"]),
      reasonCode: z.enum(["semantic_equivalence", "ambiguous", "insufficient_evidence"]),
      evidence: z.array(evidenceSchema).max(6),
      explanation: z.string().max(240),
    }),
  ),
  excludedExactPairs: z.array(rowPairSchema),
  unmatched: z.array(
    z.strictObject({
      side,
      rowId: z.string(),
      reason: z.enum([
        "duplicate_id", "conflicting_id", "missing_name", "no_candidates", "ambiguous", "rejected", "deferred",
        "analysis_limit", "analysis_failed", "analysis_cancelled", "unpaired",
      ]),
    }),
  ),
  analysis: z.strictObject({
    status: z.enum(["idle", "running", "partial", "complete", "cancelled", "failed"]),
    analyzedRows: z.number().int().min(0),
    eligibleRows: z.number().int().min(0),
    selectedRowIds: z.array(z.string()),
    analyzedRowIds: z.array(z.string()),
    failedRowIds: z.array(z.string()),
  }),
  modelRuns: z.array(
    z.strictObject({
      requestId: z.string(),
      provider: z.string(),
      model: z.string(),
      promptVersion: z.string(),
      durationMs: z.number().min(0),
      inputTokens: z.number().int().min(0).nullable(),
      outputTokens: z.number().int().min(0).nullable(),
      result: z.enum(["valid", "failed", "cancelled"]),
    }),
  ),
  policies: z.strictObject({ parser: z.literal(1), matching: z.literal(1), export: z.literal(1) }),
  invariants: z.strictObject({
    passed: z.literal(true),
    leftCount: z.number().int(),
    rightCount: z.number().int(),
    pairCount: z.number().int(),
  }),
});

export type ReplayErrorCode = "schema" | "dataset" | "configuration" | "configuration_hash" | "proposal" | "decision" | "mismatch" | "invariant";
export type ReplayError = { code: ReplayErrorCode; message: string };

export type ReplayResult = {
  matches: MatchRow[];
  unresolved: UnresolvedRow[];
  files: { "matches.csv": string; "unresolved.csv": string };
};

// Structural equality that ignores object key order.
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// §10.3: a pure, model-free check of an audit. It rebuilds state from the parsed source records
// by re-running exact matching and every recorded decision through the same policy code, then
// requires the recorded pairs, exclusions, partitions and analysis to match and returns the
// canonical export rows. Original file bytes are not in the audit, so dataset IDs (file hashes)
// are checked for shape and consistency with row IDs but cannot be recomputed.
export async function replayAudit(input: unknown): Promise<{ ok: true; value: ReplayResult } | { ok: false; error: ReplayError }> {
  const fail = (code: ReplayErrorCode, message: string) => ({ ok: false as const, error: { code, message } });

  const parsed = auditSchema.safeParse(input);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    return fail("schema", `Audit does not match schema v1 at: ${paths.join(", ")}`);
  }
  const audit = parsed.data as AuditV1;

  const [A, B] = audit.datasets;
  if (A.side !== "A" || B.side !== "B") return fail("dataset", "Datasets must be Source A then Source B.");
  for (const d of audit.datasets) {
    if (d.columns.some((c, i) => c.index !== i || c.id !== `c${i}`)) return fail("dataset", `Source ${d.side} column IDs are not positional.`);
    if (d.rows.some((r, i) => r.index !== i || r.id !== rowIdOf(d.side, d.id, i) || r.cells.length !== d.columns.length))
      return fail("dataset", `Source ${d.side} row IDs, indices or widths are inconsistent.`);
  }

  const datasets = { A, B };
  const config = validateConfiguration(datasets, audit.configuration);
  if (!config.ok) return fail("configuration", "Recorded mappings are not valid for the recorded datasets.");
  const hash = await configurationHash({ A: A.id, B: B.id }, config.value);
  if (hash !== audit.configurationHash) return fail("configuration_hash", "Configuration hash does not match datasets and mappings.");

  const ctx = buildContext(datasets, config.value, hash);
  let state: ReconciliationState = initializeState(ctx);

  const proposalIds = new Set<string>();
  for (const p of audit.proposals) {
    if (proposalIds.has(p.id)) return fail("proposal", "Duplicate proposal ID.");
    proposalIds.add(p.id);
    if (p.configurationHash !== hash) return fail("proposal", "A proposal belongs to another configuration.");
    if (proposalDefect(ctx, p)) return fail("proposal", "A proposal references invalid rows or evidence.");
  }
  state = { ...state, proposals: audit.proposals };

  for (const [i, d] of audit.decisions.entries()) {
    const r = applyDecision(state, d);
    if (!r.ok) return fail("decision", `Decision ${i} is not valid when replayed: ${r.error.code}.`);
    if (!r.changed) return fail("decision", `Decision ${i} repeats an earlier decision ID.`);
    state = r.state;
  }

  const { selectedRowIds, analyzedRowIds, failedRowIds, status } = audit.analysis;
  state = { ...state, analysis: { status, selectedRowIds, analyzedRowIds, failedRowIds } };

  if (!same(state.acceptedPairs, audit.acceptedPairs)) return fail("mismatch", "Accepted pairs differ from the replayed decisions.");
  if (!same(state.excludedExactPairs, audit.excludedExactPairs)) return fail("mismatch", "Excluded exact pairs differ from the replayed decisions.");
  const { unmatchedA, unmatchedB } = partition(state);
  const unmatched = [...unmatchedA, ...unmatchedB].map((rowId) => ({
    side: ctx.rows.get(rowId)!.side,
    rowId,
    reason: unresolvedReason(state, rowId).reason,
  }));
  if (!same(unmatched, audit.unmatched)) return fail("mismatch", "Unmatched records or reasons differ from the replayed state.");
  if (!same(analysisSummary(state), audit.analysis)) return fail("mismatch", "Analysis counts differ from the replayed state.");

  const report = checkInvariants(state);
  if (!report.ok) return fail("invariant", `Replayed state violates invariants: ${report.violations.map((v) => v.code).join(", ")}.`);
  if (!same({ passed: true, ...report.counts }, audit.invariants)) return fail("mismatch", "Recorded invariant counts differ.");

  const { matches, unresolved } = canonicalRows(state);
  return {
    ok: true,
    value: {
      matches,
      unresolved,
      files: { "matches.csv": toCsv(MATCH_FIELDS, matches, MATCHES_RAW_FIELDS), "unresolved.csv": toCsv(UNRESOLVED_FIELDS, unresolved) },
    },
  };
}
