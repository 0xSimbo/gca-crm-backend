import { db } from "../../db/db";
import { impactLeaderboardCacheByRegion } from "../../db/schema";
import {
  getImpactLeaderboardWalletUniverse,
  computeGlowImpactScores,
} from "../../routers/impact-router/helpers/impact-score";
import { getWeekRangeForImpact } from "../../routers/fractions-router/helpers/apy-helpers";
import { excludedLeaderboardWalletsSet } from "../../constants/excluded-wallets";
import { and, eq } from "drizzle-orm";

export async function updateImpactLeaderboardByRegion() {
  console.log("[Cron] Updating Impact Leaderboard By Region...");
  const start = Date.now();
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 1. Get all eligible wallets
  const universe = await getImpactLeaderboardWalletUniverse({ limit: 10000 });
  const wallets = universe.candidateWallets.filter(
    (w) => !excludedLeaderboardWalletsSet.has(w.toLowerCase())
  );

  console.log(
    `[Cron] Computing region scores for ${wallets.length} wallets (Weeks ${startWeek}-${endWeek})...`
  );
  console.log(`[Cron] This may take several minutes...`);

  // 2. Compute scores with region breakdown
  const computeStart = Date.now();
  const results = await computeGlowImpactScores({
    walletAddresses: wallets,
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
    includeRegionBreakdown: true,
  });
  console.log(
    `[Cron] Score computation complete in ${((Date.now() - computeStart) / 1000).toFixed(1)}s`
  );

  // 3. Prepare rows for insertion
  const rows: Array<{
    walletAddress: string;
    regionId: number;
    directPoints: string;
    glowWorthPoints: string;
    startWeek: number;
    endWeek: number;
  }> = [];

  for (const result of results) {
    if (!result.regionBreakdown || result.regionBreakdown.length === 0)
      continue;

    for (const region of result.regionBreakdown) {
      rows.push({
        walletAddress: result.walletAddress,
        regionId: region.regionId,
        directPoints: region.directPoints,
        glowWorthPoints: region.glowWorthPoints,
        startWeek,
        endWeek,
      });
    }
  }

  if (rows.length === 0) {
    console.log("[Cron] No region breakdown data to cache");
    return { updated: 0 };
  }

  // 4. Atomic Replace: delete old data for this week range and insert new
  await db.transaction(async (tx) => {
    // Delete existing cache for this week range
    await tx
      .delete(impactLeaderboardCacheByRegion)
      .where(
        and(
          eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
          eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
        )
      );

    // Insert new rows in chunks
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await tx
        .insert(impactLeaderboardCacheByRegion)
        .values(rows.slice(i, i + chunkSize));
    }
  });

  console.log(
    `[Cron] Impact Leaderboard By Region updated with ${rows.length} rows in ${
      (Date.now() - start) / 1000
    }s`
  );
  return { updated: rows.length };
}
