import { db } from "../../db/db";
import { impactLeaderboardCache } from "../../db/schema";
import {
  getImpactLeaderboardWalletUniverse,
  computeGlowImpactScores,
} from "../../routers/impact-router/helpers/impact-score";
import { getWeekRangeForImpact } from "../../routers/fractions-router/helpers/apy-helpers";
import { excludedLeaderboardWalletsSet } from "../../constants/excluded-wallets";

export async function updateImpactLeaderboard() {
  console.log("[Cron] Updating Impact Leaderboard...");
  const start = Date.now();
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 1. Get all eligible wallets
  const universe = await getImpactLeaderboardWalletUniverse({ limit: 10000 });
  const wallets = universe.candidateWallets.filter(
    (w) => !excludedLeaderboardWalletsSet.has(w.toLowerCase())
  );

  console.log(
    `[Cron] Computing scores for ${wallets.length} wallets (Weeks ${startWeek}-${endWeek})...`
  );
  console.log(`[Cron] This may take several minutes...`);

  // 2. Compute scores (this handles batching internally)
  const computeStart = Date.now();
  const results = await computeGlowImpactScores({
    walletAddresses: wallets,
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
  });
  console.log(
    `[Cron] Score computation complete in ${((Date.now() - computeStart) / 1000).toFixed(1)}s`
  );

  // 3. Filter and Sort
  // Filter out wallets with insignificant points (dust/rounding errors or no historical contribution)
  // Threshold: 0.01 points (prevents cluttering leaderboard with dust wallets)
  const MIN_POINTS_THRESHOLD = 0.01;
  const filteredResults = results.filter((r) => {
    const points = parseFloat(r.totals.totalPoints);
    return Number.isFinite(points) && points >= MIN_POINTS_THRESHOLD;
  });

  console.log(
    `[Cron] Filtered to ${
      filteredResults.length
    } wallets with points >= ${MIN_POINTS_THRESHOLD} (excluded ${
      results.length - filteredResults.length
    } dust/zero-point wallets)`
  );

  // Sort by totalPoints descending
  filteredResults.sort((a, b) => {
    const ap = parseFloat(a.totals.totalPoints);
    const bp = parseFloat(b.totals.totalPoints);
    return bp - ap;
  });

  const globalRegionTotals = new Map<string, bigint>();

  const rows = filteredResults.map((r, index) => {
    const hadSteeringAtEndWeek = (() => {
      try {
        const totalSteeringGlwWei = BigInt(
          r.totals?.totalSteeringGlwWei || "0"
        );
        return totalSteeringGlwWei > 0n;
      } catch {
        return false;
      }
    })();

    if (r.pointsPerRegion) {
      for (const [rid, ptsStr] of Object.entries(r.pointsPerRegion)) {
        const parts = ptsStr.split(".");
        const intPart = BigInt(parts[0] || "0");
        const fracPart = BigInt((parts[1] || "").padEnd(6, "0").slice(0, 6));
        const val = intPart * 1000000n + fracPart;
        globalRegionTotals.set(rid, (globalRegionTotals.get(rid) || 0n) + val);
      }
    }

    return {
      walletAddress: r.walletAddress,
      totalPoints: r.totals.totalPoints,
      rank: index + 1,
      glowWorthWei: r.glowWorth.glowWorthWei,
      lastWeekPoints: r.lastWeekPoints,
      startWeek,
      endWeek,
      data: {
        walletAddress: r.walletAddress,
        totalPoints: r.totals.totalPoints,
        glowWorthWei: r.glowWorth.glowWorthWei,
        composition: r.composition,
        lastWeekPoints: r.lastWeekPoints,
        activeMultiplier: r.activeMultiplier,
        hasMinerMultiplier: r.hasMinerMultiplier,
        hasSteeringStake: hadSteeringAtEndWeek,
        hasVaultBonus: (() => {
          try {
            return BigInt(r.glowWorth.delegatedActiveGlwWei || "0") > 0n;
          } catch {
            return false;
          }
        })(),
        endWeekMultiplier: r.endWeekMultiplier,
        globalRank: index + 1,
        pointsPerRegion: r.pointsPerRegion,
      },
      updatedAt: new Date(),
    };
  });

  // Early return if no wallet data to cache
  if (rows.length === 0) {
    console.log("[Cron] No wallet data to cache");
    return { updated: 0 };
  }

  // Build global region totals record for the system row
  const globalRegionTotalsRecord: Record<string, string> = {};
  for (const [rid, val] of globalRegionTotals) {
    const s = val.toString().padStart(7, "0");
    const intPart = s.slice(0, s.length - 6);
    const fracPart = s.slice(s.length - 6);
    globalRegionTotalsRecord[rid] = `${intPart}.${fracPart}`;
  }

  // Add System Row for Global Totals (different data structure, cast to satisfy TS)
  rows.push({
    walletAddress: "0x0000000000000000000000000000000000000000",
    totalPoints: "0",
    rank: -1,
    glowWorthWei: "0",
    lastWeekPoints: "0",
    startWeek,
    endWeek,
    data: {
      isSystemRow: true,
      globalRegionTotals: globalRegionTotalsRecord,
    } as unknown as (typeof rows)[0]["data"],
    updatedAt: new Date(),
  });

  // 4. Atomic Replace
  await db.transaction(async (tx) => {
    await tx.delete(impactLeaderboardCache);
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await tx
        .insert(impactLeaderboardCache)
        .values(rows.slice(i, i + chunkSize));
    }
  });

  console.log(
    `[Cron] Impact Leaderboard updated with ${rows.length} rows in ${
      (Date.now() - start) / 1000
    }s`
  );
  return { updated: rows.length };
}
