import { describe, expect, it } from "vitest";
import { configurationHash, configurationTuple, validateConfiguration, type DraftConfiguration } from "./mapping";
import { dataset, ID_NAME_QTY } from "./testkit";
import type { Configuration } from "./types";

const datasets = async () => ({ A: await dataset("A", "id,name,qty,unit\n1,x,2,kg\n"), B: await dataset("B", "id,name,qty\n1,x,2\n") });

const draft = (over: Partial<DraftConfiguration> = {}): DraftConfiguration => ({
  A: ID_NAME_QTY,
  B: ID_NAME_QTY,
  idCaseSensitive: true,
  sharedQuantityUnitConfirmed: false,
  ...over,
});

describe("validateConfiguration", () => {
  it("accepts a complete mapping and a missing product ID (exact-ID matching just turns off)", async () => {
    const r = validateConfiguration(await datasets(), draft({ B: { ...ID_NAME_QTY, productId: null } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.B.productId).toBeNull();
  });

  it("requires name and quantity", async () => {
    const r = validateConfiguration(await datasets(), draft({ A: { productId: null, name: null, quantity: null, unit: null } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual([
      { side: "A", field: "name", code: "required" },
      { side: "A", field: "quantity", code: "required" },
    ]);
  });

  it("rejects name and quantity sharing a column, and optional fields reusing a mapped column", async () => {
    const r = validateConfiguration(await datasets(), draft({ A: { productId: "c1", name: "c1", quantity: "c1", unit: "c1" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((e) => `${e.field}:${e.code}`)).toEqual(["name:column_reused", "quantity:column_reused", "unit:column_reused"]);
  });

  it("rejects columns that do not exist in that dataset", async () => {
    const r = validateConfiguration(await datasets(), draft({ B: { ...ID_NAME_QTY, unit: "c3" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual([{ side: "B", field: "unit", code: "unknown_column" }]);
  });
});

describe("configurationHash", () => {
  const base: Configuration = {
    A: { productId: "c0", name: "c1", quantity: "c2", unit: null },
    B: { productId: "c0", name: "c1", quantity: "c2", unit: null },
    idCaseSensitive: true,
    sharedQuantityUnitConfirmed: true,
    matchingPolicyVersion: 1,
  };
  const ids = { A: "a".repeat(64), B: "b".repeat(64) };

  it("is reproducible and independent of object key order", async () => {
    const reordered: Configuration = {
      matchingPolicyVersion: 1,
      sharedQuantityUnitConfirmed: true,
      idCaseSensitive: true,
      B: { unit: null, quantity: "c2", name: "c1", productId: "c0" },
      A: { unit: null, quantity: "c2", name: "c1", productId: "c0" },
    };
    expect(await configurationHash(ids, base)).toBe(await configurationHash(ids, reordered));
    expect(await configurationHash(ids, base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes a fixed-order tuple", () => {
    expect(configurationTuple(ids, base)).toEqual([
      "accord.configuration", 1, ids.A, ids.B, ["c0", "c1", "c2", null], ["c0", "c1", "c2", null], true, true, 1, 1,
    ]);
  });

  it.each([
    ["dataset A", { ids: { ...ids, A: "c".repeat(64) } }],
    ["dataset B", { ids: { ...ids, B: "c".repeat(64) } }],
    ["swapped datasets", { ids: { A: ids.B, B: ids.A } }],
    ["A mapping", { config: { ...base, A: { ...base.A, unit: "c3" } } }],
    ["B mapping", { config: { ...base, B: { ...base.B, productId: null } } }],
    ["ID case policy", { config: { ...base, idCaseSensitive: false } }],
    ["shared-unit assertion", { config: { ...base, sharedQuantityUnitConfirmed: false } }],
  ])("changes when %s changes", async (_label, change: { ids?: typeof ids; config?: Configuration }) => {
    const changed = await configurationHash(change.ids ?? ids, change.config ?? base);
    expect(changed).not.toBe(await configurationHash(ids, base));
  });
});
