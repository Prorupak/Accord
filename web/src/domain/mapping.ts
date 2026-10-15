import { sha256Hex } from "./identity";
import {
  MATCHING_POLICY_VERSION,
  PARSER_POLICY_VERSION,
  type ColumnId,
  type Configuration,
  type Dataset,
  type Mapping,
  type Result,
  type Side,
} from "./types";

export type CanonicalField = keyof Mapping;
const FIELDS: readonly CanonicalField[] = ["productId", "name", "quantity", "unit"];
const REQUIRED: ReadonlySet<CanonicalField> = new Set(["name", "quantity"]);

// Draft mappings (from the model or an unfinished form) may leave any field null (§7.2).
export type DraftMapping = { [K in CanonicalField]: ColumnId | null };

export type DraftConfiguration = {
  A: DraftMapping;
  B: DraftMapping;
  idCaseSensitive: boolean;
  sharedQuantityUnitConfirmed: boolean;
};

export type MappingError = {
  side: Side;
  field: CanonicalField;
  code: "required" | "unknown_column" | "column_reused";
};

function mappingErrors(dataset: Dataset, draft: DraftMapping): MappingError[] {
  const known = new Set(dataset.columns.map((c) => c.id));
  const used = new Set<ColumnId>();
  const errors: MappingError[] = [];
  for (const field of FIELDS) {
    const col = draft[field];
    const err = (code: MappingError["code"]) => errors.push({ side: dataset.side, field, code });
    if (col === null) {
      if (REQUIRED.has(field)) err("required");
    } else if (!known.has(col)) err("unknown_column");
    else if (used.has(col)) err("column_reused");
    else used.add(col);
  }
  return errors;
}

// §3.2: name and quantity required and distinct; optional fields cannot reuse a mapped column.
// A null productId is valid; it only disables exact-ID matching for that source.
export function validateConfiguration(
  datasets: { A: Dataset; B: Dataset },
  draft: DraftConfiguration,
): Result<Configuration, MappingError[]> {
  const errors = [...mappingErrors(datasets.A, draft.A), ...mappingErrors(datasets.B, draft.B)];
  if (errors.length > 0) return { ok: false, error: errors };
  const confirmed = (m: DraftMapping): Mapping =>
    Object.freeze({ productId: m.productId, name: m.name!, quantity: m.quantity!, unit: m.unit });
  return {
    ok: true,
    value: Object.freeze({
      A: confirmed(draft.A),
      B: confirmed(draft.B),
      idCaseSensitive: draft.idCaseSensitive,
      sharedQuantityUnitConfirmed: draft.sharedQuantityUnitConfirmed,
      matchingPolicyVersion: MATCHING_POLICY_VERSION,
    }),
  };
}

// §4.2 fixed-order tuple. An array, never an object, so the serialization cannot depend on key
// insertion order. Changing this order or its contents requires a matching policy version bump.
export function configurationTuple(datasetIds: { A: string; B: string }, config: Configuration) {
  const m = (x: Mapping) => [x.productId, x.name, x.quantity, x.unit];
  return [
    "accord.configuration",
    1,
    datasetIds.A,
    datasetIds.B,
    m(config.A),
    m(config.B),
    config.idCaseSensitive,
    config.sharedQuantityUnitConfirmed,
    PARSER_POLICY_VERSION,
    config.matchingPolicyVersion,
  ] as const;
}

// Detects stale results; it is not authentication or tamper evidence.
export function configurationHash(datasetIds: { A: string; B: string }, config: Configuration): Promise<string> {
  return sha256Hex(JSON.stringify(configurationTuple(datasetIds, config)));
}
