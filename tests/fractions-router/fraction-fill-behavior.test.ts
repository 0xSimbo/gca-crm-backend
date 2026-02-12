import { describe, expect, it } from "bun:test";
import { shouldCompleteApplicationOnFractionFill } from "../../src/db/mutations/fractions/createFraction";

describe("fraction fill behavior", () => {
  it("skips application completion for mining-center fractions", () => {
    expect(shouldCompleteApplicationOnFractionFill("mining-center")).toBe(false);
  });

  it("keeps application completion for launchpad fractions", () => {
    expect(shouldCompleteApplicationOnFractionFill("launchpad")).toBe(true);
  });
});

