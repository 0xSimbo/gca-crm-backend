import { describe, expect, it } from "bun:test";

import {
  glwWeiToPointsScaled6,
  clampToZero,
} from "../../src/routers/impact-router/helpers/points";
import {
  applyMultiplierScaled6,
  getStreakBonusMultiplierScaled6,
} from "../../src/routers/impact-router/helpers/impact-score";

describe("impact points math", () => {
  it("converts 1 GLW -> 1.0 inflation points (scaled6)", () => {
    const oneGlwWei = BigInt("1000000000000000000");
    const inflationPerGlwScaled6 = BigInt(1_000_000);
    expect(glwWeiToPointsScaled6(oneGlwWei, inflationPerGlwScaled6)).toBe(
      BigInt(1_000_000)
    );
  });

  it("converts 1 GLW -> 0.005 vault points (scaled6 = 5000)", () => {
    const oneGlwWei = BigInt("1000000000000000000");
    const vaultPerGlwScaled6 = BigInt(5_000);
    expect(glwWeiToPointsScaled6(oneGlwWei, vaultPerGlwScaled6)).toBe(
      BigInt(5_000)
    );
  });

  it("clamps negatives to zero", () => {
    expect(clampToZero(BigInt(-1))).toBe(BigInt(0));
    expect(clampToZero(BigInt(0))).toBe(BigInt(0));
    expect(clampToZero(BigInt(5))).toBe(BigInt(5));
  });

  it("computes streak bonus multiplier (scaled6) with 4-week cap", () => {
    expect(getStreakBonusMultiplierScaled6(0)).toBe(BigInt(0));
    expect(getStreakBonusMultiplierScaled6(1)).toBe(BigInt(250_000));
    expect(getStreakBonusMultiplierScaled6(2)).toBe(BigInt(500_000));
    expect(getStreakBonusMultiplierScaled6(4)).toBe(BigInt(1_000_000));
    expect(getStreakBonusMultiplierScaled6(10)).toBe(BigInt(1_000_000));
  });

  it("applies fractional multipliers to rollover points (scaled6)", () => {
    const points = BigInt(1_000_000); // 1.0 points
    const multiplier125 = BigInt(1_250_000); // 1.25x
    const multiplier375 = BigInt(3_750_000); // 3.75x

    expect(
      applyMultiplierScaled6({ pointsScaled6: points, multiplierScaled6: multiplier125 })
    ).toBe(BigInt(1_250_000));
    expect(
      applyMultiplierScaled6({ pointsScaled6: points, multiplierScaled6: multiplier375 })
    ).toBe(BigInt(3_750_000));
  });
});
