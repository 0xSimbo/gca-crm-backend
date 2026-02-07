import { describe, expect, it } from "bun:test";
import {
  applyMultiplierScaled6,
  computeSteeringBoostScaled6,
  normalizeFoundationWallets,
} from "../../src/routers/impact-router/helpers/impact-score";
import {
  formatPointsScaled6,
  glwWeiToPointsScaled6,
  GLW_DECIMALS,
} from "../../src/routers/impact-router/helpers/points";

describe("impact steering boost", () => {
  it("computes steering boost as totalStake/(totalStake-foundationStake)", () => {
    const total = 200n * GLW_DECIMALS;
    const foundation = 100n * GLW_DECIMALS;
    const boost = computeSteeringBoostScaled6({
      totalStakedWei: total,
      foundationStakedWei: foundation,
    });
    expect(boost).toBe(2_000_000n); // 2.0x
  });

  it("applies steering boost to points using scaled6 multipliers", () => {
    // Example: 500 GLW steered, 3 points per GLW => 1500 points base
    const steeredGlwWei = 500n * GLW_DECIMALS;
    const base = glwWeiToPointsScaled6(steeredGlwWei, 3_000_000n);
    const boosted = applyMultiplierScaled6({
      pointsScaled6: base,
      multiplierScaled6: 2_000_000n,
    });
    expect(formatPointsScaled6(boosted)).toBe("3000");
  });

  it("dedupes foundation wallets so stake isn't double-counted", () => {
    const wallets = [
      "0x1111111111111111111111111111111111111111",
      "0x1111111111111111111111111111111111111111",
      "0x1111111111111111111111111111111111111111".toUpperCase(),
      "0x2222222222222222222222222222222222222222",
    ];
    const normalized = normalizeFoundationWallets(wallets);
    expect(normalized).toEqual([
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
  });
});

