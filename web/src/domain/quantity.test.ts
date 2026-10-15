import { describe, expect, it } from "vitest";
import { compareQuantities, formatThousandths, parseQuantity } from "./quantity";
import { rowA, rowB, setup } from "./testkit";

describe("parseQuantity", () => {
  it.each([
    ["0", 0n],
    ["-0", 0n],
    ["12", 12_000n],
    [" 12 ", 12_000n],
    ["0012", 12_000n],
    ["1.5", 1_500n],
    ["1.005", 1_005n],
    ["-3.25", -3_250n],
    ["999999999999", 999_999_999_999_000n],
    ["-999999999999.999", -999_999_999_999_999n],
  ])("accepts %j as %s thousandths", (raw, expected) => {
    expect(parseQuantity(raw)).toEqual({ ok: true, thousandths: expected });
  });

  it.each(["1,200", "3kg", "1e3", "1.2345", "1000000000000", ".5", "5.", "+5", "1 000", "$5", "1,5", "--1", "١٢"])(
    "rejects %j as invalid, never as zero",
    (raw) => expect(parseQuantity(raw)).toEqual({ ok: false, reason: "invalid" }),
  );

  it("treats blank as missing, never zero", () => {
    expect(parseQuantity("")).toEqual({ ok: false, reason: "missing" });
    expect(parseQuantity("   ")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("formatThousandths", () => {
  it.each([
    [0n, "0"],
    [-0n, "0"],
    [1_000n, "1"],
    [1_500n, "1.5"],
    [1_050n, "1.05"],
    [1n, "0.001"],
    [-1n, "-0.001"],
    [-1_000n, "-1"],
    [999_999_999_999_999n, "999999999999.999"],
  ])("formats %s as %j", (value, expected) => expect(formatThousandths(value)).toBe(expected));
});

describe("compareQuantities", () => {
  const pairOf = async (qa: string, qb: string, over = {}) => {
    const s = await setup(`id,name,qty\nX,a,"${qa}"\n`, `id,name,qty\nX,a,"${qb}"\n`, over);
    return compareQuantities(s.context, rowA(s, 0), rowB(s, 0));
  };

  it("computes exact B minus A: 0.1 → 0.3 is 0.2 without float error", async () => {
    expect(await pairOf("0.1", "0.3")).toEqual({ status: "different", leftRaw: "0.1", rightRaw: "0.3", delta: "0.2" });
  });

  it("uses the B-minus-A sign convention: A=6, B=5 is -1", async () => {
    expect((await pairOf("6", "5")).delta).toBe("-1");
    expect((await pairOf("-2.5", "1")).delta).toBe("3.5");
  });

  it("reports equal with delta 0 for differently written equal values", async () => {
    expect(await pairOf("1.50", "1.5")).toMatchObject({ status: "equal", delta: "0" });
  });

  it("handles the extreme 12-digit range exactly", async () => {
    expect((await pairOf("-999999999999.999", "999999999999.999")).delta).toBe("1999999999999.998");
  });

  it.each([["", "5"], ["1,200", "5"], ["3kg", "5"], ["1e3", "5"], ["5", ""]])(
    "is invalid for %j vs %j and keeps raw strings",
    async (qa, qb) => {
      expect(await pairOf(qa, qb)).toEqual({ status: "invalid", leftRaw: qa, rightRaw: qb, delta: null });
    },
  );

  it("requires the shared-unit assertion when neither side maps a unit", async () => {
    expect((await pairOf("1", "2", { sharedQuantityUnitConfirmed: false })).status).toBe("unit_unknown");
  });

  describe("with unit columns", () => {
    const withUnits = async (ua: string, ub: string, mapB = true) => {
      const s = await setup(`id,name,qty,unit\nX,a,1,${ua}\n`, `id,name,qty,unit\nX,a,2,${ub}\n`, {
        A: { productId: "c0", name: "c1", quantity: "c2", unit: "c3" },
        B: { productId: "c0", name: "c1", quantity: "c2", unit: mapB ? "c3" : null },
        sharedQuantityUnitConfirmed: true,
      });
      return compareQuantities(s.context, rowA(s, 0), rowB(s, 0));
    };

    it("compares units by trim and case fold", async () => {
      expect(await withUnits(" KG", "kg ")).toMatchObject({ status: "different", delta: "1" });
    });

    it("does not convert units: kg vs kilogram is a mismatch", async () => {
      expect(await withUnits("kg", "kilogram")).toMatchObject({ status: "unit_mismatch", delta: null });
    });

    it("treats a blank unit cell as unknown, never as equivalent", async () => {
      expect((await withUnits("kg", "")).status).toBe("unit_unknown");
      expect((await withUnits("", "")).status).toBe("unit_unknown");
    });

    it("is unavailable when only one side maps units, even with the shared-unit assertion", async () => {
      expect((await withUnits("kg", "kg", false)).status).toBe("unit_unknown");
    });
  });
});
