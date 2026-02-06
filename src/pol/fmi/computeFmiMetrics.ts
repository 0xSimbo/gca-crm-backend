import { Decimal } from "../math/decimal";

export function computeFmiMetrics(params: {
  minerSalesUsdUsdc6: bigint;
  gctlMintsUsdUsdc6: bigint;
  polYieldUsdUsdc6: bigint;
  dexSellPressureUsdUsdc6: bigint;
}): {
  buyPressureUsdUsdc6: bigint;
  sellPressureUsdUsdc6: bigint;
  netUsdUsdc6: bigint;
  buySellRatio: string | null;
} {
  const buy =
    params.minerSalesUsdUsdc6 +
    params.gctlMintsUsdUsdc6 +
    params.polYieldUsdUsdc6;
  const sell = params.dexSellPressureUsdUsdc6;
  const net = buy - sell;
  const ratio =
    sell > 0n ? new Decimal(buy.toString()).div(sell.toString()).toString() : null;
  return {
    buyPressureUsdUsdc6: buy,
    sellPressureUsdUsdc6: sell,
    netUsdUsdc6: net,
    buySellRatio: ratio,
  };
}

