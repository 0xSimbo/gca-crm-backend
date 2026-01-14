import { db } from "../../db/db";
import { powerByRegionByWeek } from "../../db/schema";
import {
  getImpactLeaderboardWalletUniverse,
  computeGlowImpactScores,
} from "../../routers/impact-router/helpers/impact-score";
import { getWeekRangeForImpact } from "../../routers/fractions-router/helpers/apy-helpers";
import { excludedLeaderboardWalletsSet } from "../../constants/excluded-wallets";
import { and, eq, gte, lte } from "drizzle-orm";

export async function updatePowerByRegionByWeek(params?: {
  startWeek?: number;
  endWeek?: number;
}) {
  console.log("[Cron] Updating Power By Region By Week...");
  const start = Date.now();
  const weekRange = getWeekRangeForImpact();
  const startWeek = params?.startWeek ?? weekRange.startWeek;
  const endWeek = params?.endWeek ?? weekRange.endWeek;

  // 1. Get all eligible wallets
  const universe = await getImpactLeaderboardWalletUniverse({ limit: 10000 });
  const wallets = universe.candidateWallets.filter(
    (w) => !excludedLeaderboardWalletsSet.has(w.toLowerCase())
  );

  console.log(
    `[Cron] Computing weekly region power for ${wallets.length} wallets (Weeks ${startWeek}-${endWeek})...`
  );

  // 2. Compute scores with weekly region breakdown
  const results = await computeGlowImpactScores({
    walletAddresses: wallets,
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
    includeWeeklyRegionBreakdown: true,
  });

  // 3. Prepare rows for insertion
  const rows: Array<{
    walletAddress: string;
    regionId: number;
    weekNumber: number;
    directPoints: string;
    glowWorthPoints: string;
  }> = [];

  for (const result of results) {
    if (!result.weeklyRegionBreakdown || result.weeklyRegionBreakdown.length === 0)
      continue;

    for (const item of result.weeklyRegionBreakdown) {
      rows.push({
        walletAddress: result.walletAddress,
        regionId: item.regionId,
        weekNumber: item.weekNumber,
        directPoints: item.directPoints,
        glowWorthPoints: item.glowWorthPoints,
      });
    }
  }

  if (rows.length === 0) {
    console.log("[Cron] No weekly region power data to cache");
    return { updated: 0 };
  }

  // 4. Atomic Replace: delete old data for this week range and insert new
  await db.transaction(async (tx) => {
    // Delete existing cache for the weeks we just computed
    await tx
      .delete(powerByRegionByWeek)
      .where(
        and(
          gte(powerByRegionByWeek.weekNumber, startWeek),
          lte(powerByRegionByWeek.weekNumber, endWeek)
        )
      );

    // Insert new rows in chunks
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await tx
        .insert(powerByRegionByWeek)
        .values(rows.slice(i, i + chunkSize));
    }
  });

  console.log(
    `[Cron] Power By Region By Week updated with ${rows.length} rows in ${
      (Date.now() - start) / 1000
    }s`
  );
  return { updated: rows.length };
}
