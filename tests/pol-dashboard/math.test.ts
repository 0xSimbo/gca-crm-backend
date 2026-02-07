import { describe, expect, it } from "bun:test";
import { bucketEvenlyAcrossWeeks } from "../../src/pol/math/bucketing";
import {
  getProtocolWeekForTimestamp,
  getProtocolWeekStartTimestamp,
} from "../../src/pol/protocolWeeks";
import { lqAtomicToUsdUsdc6, usdUsdc6ToLqAtomic } from "../../src/pol/math/usdLq";

describe("PoL Dashboard: protocol weeks", () => {
  it("computes week number and boundaries consistently", () => {
    const week0Start = 1700352000;
    expect(getProtocolWeekForTimestamp(week0Start)).toBe(0);
    expect(getProtocolWeekForTimestamp(week0Start + 604800)).toBe(1);
    expect(getProtocolWeekStartTimestamp(2)).toBe(week0Start + 2 * 604800);
  });
});

describe("PoL Dashboard: bucketing", () => {
  it("splits with remainder distributed to earliest weeks", () => {
    const out = bucketEvenlyAcrossWeeks({ amount: 10n, startWeek: 5, weeks: 3 });
    expect(out).toEqual([
      { week: 5, amount: 4n },
      { week: 6, amount: 3n },
      { week: 7, amount: 3n },
    ]);
  });
});

describe("PoL Dashboard: USD/LQ conversion", () => {
  it("round-trips approximately with floor rounding", () => {
    // spot price = 1.00 USD per GLW
    const spot = "1.000000";
    const usd = 1_000_000n; // $1.00 in USDC6
    const lq = usdUsdc6ToLqAtomic({ usdUsdc6: usd, spotPriceUsdgPerGlw: spot });
    const usd2 = lqAtomicToUsdUsdc6({ lqAtomic: lq, spotPriceUsdgPerGlw: spot });
    expect(usd2).toBeLessThanOrEqual(usd);
    // Floor rounding should be close for small values.
    expect(usd - usd2).toBeLessThan(20_000n); // < $0.02
  });
});

