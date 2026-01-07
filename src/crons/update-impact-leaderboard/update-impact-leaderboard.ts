import { db } from "../../db/db";
import { impactLeaderboardCache } from "../../db/schema";
import {
  getImpactLeaderboardWalletUniverse,
  computeGlowImpactScores,
} from "../../routers/impact-router/helpers/impact-score";
import { getWeekRangeForImpact } from "../../routers/fractions-router/helpers/apy-helpers";

// Same excluded wallets as impactRouter.ts
const EXCLUDED_LEADERBOARD_WALLETS = new Set(
  [
    "0x6972B05A0c80064fBE8a10CBc2a2FBCF6fb47D6a",
    "0x0b650820dde452b204de44885fc0fbb788fc5e37",
  ].map((w) => w.toLowerCase())
);

export async function updateImpactLeaderboard() {
  console.log("[Cron] Updating Impact Leaderboard...");
  const start = Date.now();
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 1. Get all eligible wallets
  const universe = await getImpactLeaderboardWalletUniverse({ limit: 10000 });
  const wallets = universe.candidateWallets.filter(
    (w) => !EXCLUDED_LEADERBOARD_WALLETS.has(w.toLowerCase())
  );

  console.log(
    `[Cron] Computing scores for ${wallets.length} wallets (Weeks ${startWeek}-${endWeek})...`
  );

  // 2. Compute scores (this handles batching internally)
  const results = await computeGlowImpactScores({
    walletAddresses: wallets,
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
  });

  // 3. Sort and Rank
  // Sort by totalPoints descending
  results.sort((a, b) => {
    const ap = parseFloat(a.totals.totalPoints);
    const bp = parseFloat(b.totals.totalPoints);
    return bp - ap;
  });

  const rows = results.map((r, index) => {
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
      },
      updatedAt: new Date(),
    };
  });

  if (rows.length === 0) return { updated: 0 };

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

