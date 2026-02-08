import { lqAtomicToUsdUsdc6 } from "../math/usdLq";
import {
  getProtocolWeekEndTimestamp,
  getProtocolWeekStartTimestamp,
} from "../protocolWeeks";

export type PolLiquidityPoint = {
  timestamp: string;
  spotPrice: string;
  endowment: { lq: string };
  botActive: { lq: string };
  total: { lq: string };
};

export type WeeklyPolLiquidityRow = {
  weekNumber: number;
  asOfTimestamp: number | null;
  spotPriceUsdgPerGlw: string | null;
  endowmentLq: string;
  botActiveLq: string;
  totalLq: string;
  totalUsdUsdc6: string | null;
};

export function computeWeeklyPolLiquiditySeries(params: {
  startWeek: number;
  endWeek: number;
  // Must be sorted by ascending timestamp.
  points: PolLiquidityPoint[];
}): WeeklyPolLiquidityRow[] {
  const { startWeek, endWeek, points } = params;
  const out: WeeklyPolLiquidityRow[] = [];

  let idx = 0;
  let last: PolLiquidityPoint | null = null;

  for (let w = startWeek; w <= endWeek; w++) {
    const weekStart = getProtocolWeekStartTimestamp(w);
    const weekEnd = getProtocolWeekEndTimestamp(w);

    // Advance up to weekEnd (as-of).
    while (idx < points.length) {
      const ts = Number(points[idx]!.timestamp);
      if (!Number.isFinite(ts) || ts < weekStart) {
        // If the point is earlier than our window, treat it as "last" and continue.
        last = points[idx]!;
        idx += 1;
        continue;
      }
      if (ts <= weekEnd) {
        last = points[idx]!;
        idx += 1;
        continue;
      }
      break;
    }

    const endowmentLq = BigInt(last?.endowment?.lq ?? "0");
    const botActiveLq = BigInt(last?.botActive?.lq ?? "0");
    const totalLq = BigInt(last?.total?.lq ?? (endowmentLq + botActiveLq).toString());
    const spot = last?.spotPrice ?? null;

    let totalUsdUsdc6: string | null = null;
    if (spot && totalLq > 0n) {
      // usd = 2 * lq * sqrt(price) in atomic units (USDC6).
      totalUsdUsdc6 = lqAtomicToUsdUsdc6({
        lqAtomic: totalLq,
        spotPriceUsdgPerGlw: spot,
      }).toString();
    }

    out.push({
      weekNumber: w,
      asOfTimestamp: last ? Number(last.timestamp) : null,
      spotPriceUsdgPerGlw: spot,
      endowmentLq: endowmentLq.toString(),
      botActiveLq: botActiveLq.toString(),
      totalLq: totalLq.toString(),
      totalUsdUsdc6,
    });
  }

  return out;
}

