import { describe, expect, it } from "bun:test";
import { computeFmiMetrics } from "../../src/pol/fmi/computeFmiMetrics";

describe("PoL Dashboard: FMI metrics", () => {
  it("computes buy/sell/net and ratio", () => {
    const out = computeFmiMetrics({
      minerSalesUsdUsdc6: 100n,
      gctlMintsUsdUsdc6: 200n,
      polYieldUsdUsdc6: 300n,
      dexSellPressureUsdUsdc6: 50n,
    });
    expect(out.buyPressureUsdUsdc6).toBe(600n);
    expect(out.sellPressureUsdUsdc6).toBe(50n);
    expect(out.netUsdUsdc6).toBe(550n);
    expect(out.buySellRatio).toBe("12");
  });

  it("returns null ratio when sell is zero", () => {
    const out = computeFmiMetrics({
      minerSalesUsdUsdc6: 1n,
      gctlMintsUsdUsdc6: 0n,
      polYieldUsdUsdc6: 0n,
      dexSellPressureUsdUsdc6: 0n,
    });
    expect(out.buySellRatio).toBeNull();
  });
});

