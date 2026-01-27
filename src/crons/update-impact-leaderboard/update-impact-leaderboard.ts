import { db } from "../../db/db";
import {
  impactLeaderboardCache,
  referrals,
  referralPointsWeekly,
} from "../../db/schema";
import {
  getImpactLeaderboardWalletUniverse,
  computeGlowImpactScores,
} from "../../routers/impact-router/helpers/impact-score";
import { getWeekRangeForImpact } from "../../routers/fractions-router/helpers/apy-helpers";
import { excludedLeaderboardWalletsSet } from "../../constants/excluded-wallets";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  calculateReferrerShare,
  calculateRefereeBonus,
  calculateRefereeActivationBonus,
  applyPostLinkProration,
  isWithinBonusPeriod,
} from "../../routers/impact-router/helpers/referral-points";
import { GENESIS_TIMESTAMP } from "../../constants/genesis-timestamp";
import { formatPointsScaled6 } from "../../routers/impact-router/helpers/points";
import { dateToEpoch } from "../../utils/getProtocolWeek";
import {
  ACTIVATION_THRESHOLD_SCALED6,
  buildActiveReferralCountMap,
  findActivationCandidates,
  type ReferralSnapshot,
} from "./referral-cron-helpers";

export async function updateImpactLeaderboard() {
  console.log("[Cron] Updating Impact Leaderboard...");
  const start = Date.now();
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 1. Get all eligible wallets
  const universe = await getImpactLeaderboardWalletUniverse({ limit: 10000 });
  const candidateWallets = universe.candidateWallets
    .map((w) => w.toLowerCase())
    .filter((w) => !excludedLeaderboardWalletsSet.has(w));
  const candidateWalletSet = new Set(candidateWallets);

  const allReferrals = await db.select().from(referrals);
  const refereeWallets = new Set(
    allReferrals.map((ref) => ref.refereeWallet.toLowerCase())
  );
  const walletsToCompute = Array.from(
    new Set([...candidateWallets, ...refereeWallets])
  );

  console.log(
    `[Cron] Computing scores for ${walletsToCompute.length} wallets (Weeks ${startWeek}-${endWeek})...`
  );
  console.log(`[Cron] This may take several minutes...`);

  // 2. Compute scores (this handles batching internally)
  const computeStart = Date.now();
  const results = await computeGlowImpactScores({
    walletAddresses: walletsToCompute,
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
  });
  console.log(
    `[Cron] Score computation complete in ${((Date.now() - computeStart) / 1000).toFixed(1)}s`
  );

  // 3. Referral processing
  console.log("[Cron] Processing referral points...");
  const referralPointsByWallet = new Map<string, bigint>();
  const refereeBonusByWallet = new Map<string, bigint>();

  // Helper to parse scaled6 points
  const parseScaled6 = (val: string | undefined) => {
    if (!val) return 0n;
    const raw = val.trim();
    if (!raw) return 0n;
    const isNeg = raw.startsWith("-");
    const abs = isNeg ? raw.slice(1) : raw;
    const parts = abs.split(".");
    if (parts.length > 2) return 0n;
    const intPartRaw = parts[0] ?? "";
    const fracRaw = parts[1] ?? "";

    const intPart = intPartRaw === "" ? "0" : intPartRaw;
    if (!/^\d+$/.test(intPart)) return 0n;
    if (fracRaw !== "" && !/^\d+$/.test(fracRaw)) return 0n;

    const frac = (fracRaw + "000000").slice(0, 6);
    let out = BigInt(intPart) * 1_000_000n + BigInt(frac);
    if (isNeg) out = -out;
    return out;
  };

  // Index base results by wallet for fast lookup
  const resultsByWallet = new Map<string, (typeof results)[0]>();
  for (const r of results) resultsByWallet.set(r.walletAddress.toLowerCase(), r);

  const activationStartWeekByReferee = new Map<string, number>();
  for (const ref of allReferrals) {
    const refereeWallet = ref.refereeWallet.toLowerCase();
    const linkedWeek = dateToEpoch(ref.linkedAt);
    activationStartWeekByReferee.set(
      refereeWallet,
      Math.max(linkedWeek, startWeek)
    );
  }

  const historicalBasePointsByReferee = new Map<string, bigint>();
  const refereeWalletList = Array.from(refereeWallets);
  if (refereeWalletList.length > 0) {
    const historicalRows = await db
      .select({
        refereeWallet: referralPointsWeekly.refereeWallet,
        weekNumber: referralPointsWeekly.weekNumber,
        basePoints: referralPointsWeekly.refereeBasePointsScaled6,
      })
      .from(referralPointsWeekly)
      .where(
        and(
          inArray(referralPointsWeekly.refereeWallet, refereeWalletList),
          lt(referralPointsWeekly.weekNumber, endWeek)
        )
      );

    for (const row of historicalRows) {
      const refereeWallet = row.refereeWallet.toLowerCase();
      const activationStartWeek =
        activationStartWeekByReferee.get(refereeWallet);
      if (activationStartWeek == null) continue;
      if (row.weekNumber < activationStartWeek) continue;
      const basePoints = parseScaled6(row.basePoints);
      if (basePoints <= 0n) continue;
      historicalBasePointsByReferee.set(
        refereeWallet,
        (historicalBasePointsByReferee.get(refereeWallet) || 0n) + basePoints
      );
    }
  }

  const basePointsThisWeekByReferee = new Map<string, bigint>();
  for (const ref of allReferrals) {
    const refereeWallet = ref.refereeWallet.toLowerCase();
    if (basePointsThisWeekByReferee.has(refereeWallet)) continue;
    const refereeResult = resultsByWallet.get(refereeWallet);
    if (!refereeResult) continue;
    const basePointsScaled6 = parseScaled6(
      refereeResult.totals.basePointsPreMultiplierScaled6ThisWeek
    );
    basePointsThisWeekByReferee.set(
      refereeWallet,
      applyPostLinkProration({
        basePointsScaled6,
        linkedAt: ref.linkedAt,
        weekNumber: endWeek,
      })
    );
  }

  const activationCandidates = findActivationCandidates({
    referrals: allReferrals as ReferralSnapshot[],
    basePointsThisWeekByReferee,
    historicalBasePointsByReferee,
    activationStartWeekByReferee,
    endWeek,
    thresholdScaled6: ACTIVATION_THRESHOLD_SCALED6,
  });

  const activeReferralCountMap = buildActiveReferralCountMap({
    referrals: allReferrals as ReferralSnapshot[],
    activationCandidates,
  });

  for (const ref of allReferrals) {
    if (!activationCandidates.has(ref.id)) continue;
    const now = new Date();
    await db
      .update(referrals)
      .set({
        status: "active",
        activatedAt: now,
        activationBonusAwarded: true,
        activationBonusAwardedAt: now,
        updatedAt: now,
      })
      .where(eq(referrals.id, ref.id));
    ref.status = "active";
    ref.activatedAt = now;
    ref.activationBonusAwarded = true;
    ref.activationBonusAwardedAt = now;

    const bonus = calculateRefereeActivationBonus();
    const rfw = ref.refereeWallet.toLowerCase();
    refereeBonusByWallet.set(rfw, (refereeBonusByWallet.get(rfw) || 0n) + bonus);
  }

  for (const ref of allReferrals) {
    const refereeWallet = ref.refereeWallet.toLowerCase();
    const refereeResult = resultsByWallet.get(refereeWallet);
    if (!refereeResult) continue;

    const basePointsScaled6 =
      basePointsThisWeekByReferee.get(refereeWallet) || 0n;
    const referrerWallet = ref.referrerWallet.toLowerCase();
    const referrerResult = resultsByWallet.get(referrerWallet);
    const referrerBasePointsScaled6 = parseScaled6(
      referrerResult?.totals.basePointsPreMultiplierScaled6
    );

    let share = 0n;
    if (ref.status === "active" && basePointsScaled6 > 0n) {
      const activeCount =
        activeReferralCountMap.get(referrerWallet) || 0;
      share = calculateReferrerShare(
        basePointsScaled6,
        activeCount,
        referrerBasePointsScaled6
      );
      const rw = referrerWallet;
      referralPointsByWallet.set(
        rw,
        (referralPointsByWallet.get(rw) || 0n) + share
      );
    }

    const weekEndTimestamp = GENESIS_TIMESTAMP + (endWeek + 1) * 604800;
    const bonusActive = isWithinBonusPeriod({
      refereeBonusEndsAt: ref.refereeBonusEndsAt,
      weekEndTimestamp,
    });
    const refereeBonus =
      bonusActive && basePointsScaled6 > 0n
        ? calculateRefereeBonus(basePointsScaled6)
        : 0n;

    if (refereeBonus > 0n) {
      const rfw = ref.refereeWallet.toLowerCase();
      refereeBonusByWallet.set(
        rfw,
        (refereeBonusByWallet.get(rfw) || 0n) + refereeBonus
      );
    }

    const activationBonusWeek = ref.activationBonusAwardedAt
      ? dateToEpoch(ref.activationBonusAwardedAt) - 1
      : null;
    const activationBonus =
      activationCandidates.has(ref.id) || activationBonusWeek === endWeek
        ? calculateRefereeActivationBonus()
        : 0n;

    if (
      basePointsScaled6 > 0n ||
      share > 0n ||
      refereeBonus > 0n ||
      activationBonus > 0n
    ) {
      await db
        .insert(referralPointsWeekly)
        .values({
          referrerWallet: ref.referrerWallet.toLowerCase(),
          refereeWallet: ref.refereeWallet.toLowerCase(),
          weekNumber: endWeek,
          refereeBasePointsScaled6: formatPointsScaled6(basePointsScaled6),
          referrerEarnedPointsScaled6: formatPointsScaled6(share),
          refereeBonusPointsScaled6: formatPointsScaled6(refereeBonus),
          activationBonusPointsScaled6: formatPointsScaled6(activationBonus),
          refereeBonusActive: bonusActive,
        })
        .onConflictDoUpdate({
          target: [
            referralPointsWeekly.referrerWallet,
            referralPointsWeekly.refereeWallet,
            referralPointsWeekly.weekNumber,
          ],
          set: {
            refereeBasePointsScaled6: formatPointsScaled6(basePointsScaled6),
            referrerEarnedPointsScaled6: formatPointsScaled6(share),
            refereeBonusPointsScaled6: formatPointsScaled6(refereeBonus),
            activationBonusPointsScaled6: formatPointsScaled6(activationBonus),
            refereeBonusActive: bonusActive,
            updatedAt: new Date(),
          },
        });
    }
  }

  // 4. Merge referral points into results
  for (const r of results) {
    const w = r.walletAddress.toLowerCase();
    const referralPts = referralPointsByWallet.get(w) || 0n;
    const bonusPts = refereeBonusByWallet.get(w) || 0n;

    if (referralPts > 0n || bonusPts > 0n) {
      const currentTotal = parseScaled6(r.totals.totalPoints);
      const newTotal = currentTotal + referralPts + bonusPts;
      r.totals.totalPoints = formatPointsScaled6(newTotal);

      // Update composition
      (r.composition as any).referralPoints = formatPointsScaled6(referralPts);
      (r.composition as any).referralBonusPoints = formatPointsScaled6(bonusPts);
    }
  }

  // 5. Filter and Sort
  // Filter out wallets with insignificant points (dust/rounding errors or no historical contribution)
  // Threshold: 0.01 points (prevents cluttering leaderboard with dust wallets)
  const MIN_POINTS_THRESHOLD = 0.01;
  const leaderboardResults = results.filter((r) =>
    candidateWalletSet.has(r.walletAddress.toLowerCase())
  );
  const filteredResults = leaderboardResults.filter((r) => {
    const points = parseFloat(r.totals.totalPoints);
    return Number.isFinite(points) && points >= MIN_POINTS_THRESHOLD;
  });


  console.log(
    `[Cron] Filtered to ${
      filteredResults.length
    } wallets with points >= ${MIN_POINTS_THRESHOLD} (excluded ${
      leaderboardResults.length - filteredResults.length
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
