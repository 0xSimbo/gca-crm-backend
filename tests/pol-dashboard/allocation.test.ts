import { describe, expect, it } from "bun:test";
import { allocateAmountByWeights } from "../../src/pol/math/allocation";

describe("PoL Dashboard: allocation", () => {
  it("allocates proportionally and preserves sum", () => {
    const weights = new Map<string, bigint>([
      ["a", 1n],
      ["b", 3n],
    ]);
    const out = allocateAmountByWeights({ amount: 10n, weightsByKey: weights });
    expect(out.get("a")).toBe(3n);
    expect(out.get("b")).toBe(7n);
    expect((out.get("a") ?? 0n) + (out.get("b") ?? 0n)).toBe(10n);
  });

  it("falls back to even split when all weights are zero", () => {
    const weights = new Map<string, bigint>([
      ["b", 0n],
      ["a", 0n],
      ["c", 0n],
    ]);
    const out = allocateAmountByWeights({ amount: 5n, weightsByKey: weights });
    // Keys are sorted; remainder goes to earliest keys.
    expect(Array.from(out.entries())).toEqual([
      ["a", 2n],
      ["b", 2n],
      ["c", 1n],
    ]);
  });
});

