import { describe, expect, it } from "bun:test";

import {
  glwWeiToPointsScaled6,
  clampToZero,
} from "../../src/routers/impact-router/helpers/points";

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
});
