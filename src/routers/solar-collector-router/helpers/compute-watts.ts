import { db } from "../../../db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  powerByRegionByWeek,
  impactLeaderboardCacheByRegion,
  fractionSplits,
  fractions,
} from "../../../db/schema";
import { eq, isNotNull, and, inArray, sql, gte, lte } from "drizzle-orm";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../../fractions-router/helpers/apy-helpers";
import { computeGlowImpactScores } from "../../impact-router/helpers/impact-score";
import { fetchDepositSplitsHistoryBatch } from "../../impact-router/helpers/control-api";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";

export interface WattsByRegion {
  [regionId: number]: number;
}

export interface PowerByRegion {
  [regionId: number]: {
    userPower: number;
    totalNetworkPower: number;
    powerPercentile: number;
    rank: number;
    totalWallets: number;
  };
}

export interface RecentDrop {
  farmId: string;
  farmName: string | null;
  regionId: number;
  timestamp: Date;
  farmSizeWatts: number;
  wattsCaptured: number;
}

export interface WeeklyHistoryItem {
  weekNumber: number;
  wattsCaptured: number;
  cumulativeWatts: number;
  regionalShare: {
    [regionId: number]: {
      sharePercent: number;
      userPower: number;
      networkPower: number;
      wattsCaptured: number;
    };
  };
}

export interface WeeklyPowerHistoryItem {
  weekNumber: number;
  regionId: number;
  directPoints: number;
  glowWorthPoints: number;
  // Multiplier info for this week (shared across all regions)
  rolloverMultiplier: number;
  hasCashMinerBonus: boolean;
  streakBonusMultiplier: number;
  impactStreakWeeks: number;
}

export interface ComputeWattsResult {
  totalWatts: number;
  wattsByRegion: WattsByRegion;
  powerByRegion: PowerByRegion;
  strongholdRegionId: number | null;
  recentDrop: RecentDrop | null;
  weeklyHistory: WeeklyHistoryItem[];
  weeklyPowerHistory: WeeklyPowerHistoryItem[];
}

/**
 * Computes the total Watts captured by a user across all finalized farms,
 * broken down by region using the region-based Power formula:
 * Power(user, region) = Points_Direct + Points_GlowWorth
 *
 * Note: glowWorthPoints in the cache is already distributed by emission share
 * during the impact leaderboard cron, so no multiplication needed here.
 *
 * @param walletAddress - The user's wallet address.
 */
export async function computeTotalWattsCaptured(
  walletAddress: string,
  params?: {
    powerEndWeek?: number;
  }
): Promise<ComputeWattsResult> {
  const wallet = walletAddress.toLowerCase();

  // V2_START_WEEK: Only count farms from week 97+ (when vault ownership tracking started)
  const V2_START_WEEK = 97;

  // 1. Fetch all finalized farms
  const allFinalizedFarms = await db
    .select({
      farmId: farms.id,
      farmName: farms.name,
      regionId: farms.zoneId,
      createdAt: farms.createdAt,
      systemWattageOutput: applicationsAuditFieldsCRS.systemWattageOutput,
      paymentDate: applications.paymentDate,
    })
    .from(farms)
    .innerJoin(applications, eq(farms.id, applications.farmId))
    .leftJoin(
      applicationsAuditFieldsCRS,
      eq(applications.id, applicationsAuditFieldsCRS.applicationId)
    )
    .where(isNotNull(farms.protocolFeePaymentHash));

  // 2. Get the week range for impact scores (this is the range of COMPLETED weeks)
  const { startWeek, endWeek: completedEndWeek } = getWeekRangeForImpact();
  const powerEndWeek = params?.powerEndWeek ?? completedEndWeek;

  // 2.5 Fetch latest aggregate power as fallback (in case weekly snapshots are missing)
  const fallbackRegionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, completedEndWeek)
      )
    );

  const fallbackUserPowerMap = new Map<number, number>();
  const fallbackNetworkPowerMap = new Map<number, number>();
  const fallbackWalletsByRegion = new Map<number, number[]>();

  for (const row of fallbackRegionRows) {
    const rid = row.regionId;
    const power = Number(row.directPoints) + Number(row.glowWorthPoints);
    if (row.walletAddress.toLowerCase() === wallet) {
      fallbackUserPowerMap.set(rid, power);
    }
    fallbackNetworkPowerMap.set(
      rid,
      (fallbackNetworkPowerMap.get(rid) || 0) + power
    );
    if (!fallbackWalletsByRegion.has(rid)) {
      fallbackWalletsByRegion.set(rid, []);
    }
    fallbackWalletsByRegion.get(rid)!.push(power);
  }

  // Filter to only include v2 farms from COMPLETED weeks
  const finalizedFarms = allFinalizedFarms.filter((farm) => {
    const dropDate = farm.paymentDate || farm.createdAt;
    const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
    return weekNumber >= V2_START_WEEK && weekNumber <= completedEndWeek;
  });

  if (finalizedFarms.length === 0) {
    return {
      totalWatts: 0,
      wattsByRegion: {},
      powerByRegion: {},
      strongholdRegionId: null,
      recentDrop: null,
      weeklyHistory: [],
      weeklyPowerHistory: [],
    };
  }

  // 3. Identify all weeks where farms went live
  const weeks = Array.from(
    new Set(
      finalizedFarms.map((f) => {
        const dropDate = f.paymentDate || f.createdAt;
        return getCurrentEpoch(dropDate.getTime() / 1000);
      })
    )
  );

  // 4. Fetch user power for those weeks/regions
  const userPowerRows = await db
    .select()
    .from(powerByRegionByWeek)
    .where(
      and(
        eq(powerByRegionByWeek.walletAddress, wallet),
        inArray(powerByRegionByWeek.weekNumber, weeks)
      )
    );

  // 5. Fetch network total power for those weeks/regions
  const networkPowerRows = await db
    .select({
      weekNumber: powerByRegionByWeek.weekNumber,
      regionId: powerByRegionByWeek.regionId,
      totalPower: sql<string>`SUM(direct_points + glow_worth_points)`,
    })
    .from(powerByRegionByWeek)
    .where(inArray(powerByRegionByWeek.weekNumber, weeks))
    .groupBy(powerByRegionByWeek.weekNumber, powerByRegionByWeek.regionId);

  let weeklyPowerHistoryRows = await db
    .select({
      weekNumber: powerByRegionByWeek.weekNumber,
      regionId: powerByRegionByWeek.regionId,
      directPoints: powerByRegionByWeek.directPoints,
      glowWorthPoints: powerByRegionByWeek.glowWorthPoints,
    })
    .from(powerByRegionByWeek)
    .where(
      and(
        eq(powerByRegionByWeek.walletAddress, wallet),
        gte(powerByRegionByWeek.weekNumber, V2_START_WEEK),
        lte(powerByRegionByWeek.weekNumber, powerEndWeek)
      )
    )
    .orderBy(powerByRegionByWeek.weekNumber, powerByRegionByWeek.regionId);

  const shouldUseLivePower = powerEndWeek > completedEndWeek;
  if (shouldUseLivePower) {
    try {
      const [result] = await computeGlowImpactScores({
        walletAddresses: [wallet],
        startWeek: V2_START_WEEK,
        endWeek: powerEndWeek,
        includeWeeklyBreakdown: false,
        includeWeeklyRegionBreakdown: true,
      });

      if (result?.weeklyRegionBreakdown?.length) {
        weeklyPowerHistoryRows = result.weeklyRegionBreakdown.map((item) => ({
          weekNumber: item.weekNumber,
          regionId: item.regionId,
          directPoints: item.directPoints,
          glowWorthPoints: item.glowWorthPoints,
        }));
      }
    } catch {
      // Fallback to cached-only weekly history if on-the-fly computation fails.
    }
  } else if (weeklyPowerHistoryRows.length === 0) {
    try {
      const [result] = await computeGlowImpactScores({
        walletAddresses: [wallet],
        startWeek: V2_START_WEEK,
        endWeek: powerEndWeek,
        includeWeeklyBreakdown: false,
        includeWeeklyRegionBreakdown: true,
      });

      if (result?.weeklyRegionBreakdown?.length) {
        weeklyPowerHistoryRows = result.weeklyRegionBreakdown.map((item) => ({
          weekNumber: item.weekNumber,
          regionId: item.regionId,
          directPoints: item.directPoints,
          glowWorthPoints: item.glowWorthPoints,
        }));
      }
    } catch {
      // Fallback to empty weekly history if on-the-fly computation fails.
    }
  }

  // 6. Build lookup maps
  const userPowerMap = new Map<string, number>(); // key: "week-region"
  for (const row of userPowerRows) {
    userPowerMap.set(
      `${row.weekNumber}-${row.regionId}`,
      Number(row.directPoints) + Number(row.glowWorthPoints)
    );
  }

  const networkPowerMap = new Map<string, number>(); // key: "week-region"
  for (const row of networkPowerRows) {
    networkPowerMap.set(
      `${row.weekNumber}-${row.regionId}`,
      Number(row.totalPower)
    );
  }

  // 7. Calculate watts for each farm using the correct week's power
  const wattsByRegion: WattsByRegion = {};
  const farmsWithCapture: Array<RecentDrop> = [];
  const weeklyRegionalData = new Map<
    number,
    WeeklyHistoryItem["regionalShare"]
  >();

  for (const farm of finalizedFarms) {
    // EXCLUDE Region 1 (CGP) farms from the collector
    if (farm.regionId === 1) continue;

    const dropDate = farm.paymentDate || farm.createdAt;
    const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
    const regionId = farm.regionId;
    const key = `${weekNumber}-${regionId}`;

    // Check if network data exists for this week-region
    // This tells us if the week has been populated (vs being a data gap)
    const hasNetworkDataForWeek = networkPowerMap.has(key);

    // FALLBACK LOGIC:
    // - If weekly snapshot exists → use it
    // - If NO network data for this week-region (data gap) → use fallback
    // - If network data EXISTS but user has no row → user had 0 power (not participating)
    const userPower = userPowerMap.has(key)
      ? userPowerMap.get(key)!
      : hasNetworkDataForWeek
      ? 0 // Network has data but user doesn't → user had 0 power
      : fallbackUserPowerMap.get(regionId) || 0; // No data at all → fallback

    const totalNetworkPower = hasNetworkDataForWeek
      ? networkPowerMap.get(key)!
      : fallbackNetworkPowerMap.get(regionId) || 0;

    if (userPower <= 0 || totalNetworkPower <= 0) continue;

    // Parse capacity
    let capacityWatts = 0;
    const wattageOutputStr = farm.systemWattageOutput || "";
    const match = wattageOutputStr.match(/([\d.]+)/);
    if (match) {
      const kW = parseFloat(match[1]);
      if (!Number.isNaN(kW)) capacityWatts = kW * 1000;
    }

    const wattsCaptured = capacityWatts * (userPower / totalNetworkPower);

    if (wattsCaptured > 0) {
      wattsByRegion[regionId] = (wattsByRegion[regionId] || 0) + wattsCaptured;
      farmsWithCapture.push({
        farmId: farm.farmId,
        farmName: farm.farmName,
        regionId: farm.regionId,
        timestamp: dropDate,
        farmSizeWatts: Math.round(capacityWatts),
        wattsCaptured: Math.round(wattsCaptured),
      });

      // Track weekly regional data
      if (!weeklyRegionalData.has(weekNumber)) {
        weeklyRegionalData.set(weekNumber, {});
      }
      const weekData = weeklyRegionalData.get(weekNumber)!;
      if (!weekData[regionId]) {
        weekData[regionId] = {
          sharePercent: (userPower / totalNetworkPower) * 100,
          userPower,
          networkPower: totalNetworkPower,
          wattsCaptured: 0,
        };
      }
      weekData[regionId].wattsCaptured += wattsCaptured;
    }
  }

  // 8. Sum all regions to get total watts
  const totalWatts = Math.round(
    Object.values(wattsByRegion).reduce((sum, watts) => sum + watts, 0)
  );

  // 8.5 Generate weekly history
  const weeklyHistory: WeeklyHistoryItem[] = [];
  const sortedWeeks = Array.from(weeklyRegionalData.keys()).sort(
    (a, b) => a - b
  );
  let cumulativeWatts = 0;

  for (const weekNumber of sortedWeeks) {
    const regionalShare = weeklyRegionalData.get(weekNumber)!;
    const weekWatts = Object.values(regionalShare).reduce(
      (sum, r) => sum + r.wattsCaptured,
      0
    );
    cumulativeWatts += weekWatts;

    weeklyHistory.push({
      weekNumber,
      wattsCaptured: Math.round(weekWatts),
      cumulativeWatts: Math.round(cumulativeWatts),
      regionalShare,
    });
  }

  // 8.6 Compute weekly multipliers for the wallet
  // Fetch mining-center purchases for cash miner bonus
  const allWeeksForPower = Array.from(
    new Set(weeklyPowerHistoryRows.map((r) => r.weekNumber))
  );
  const minWeekForPower =
    allWeeksForPower.length > 0 ? Math.min(...allWeeksForPower) : V2_START_WEEK;
  const maxWeekForPower =
    allWeeksForPower.length > 0 ? Math.max(...allWeeksForPower) : powerEndWeek;

  // Seed streak calculation from 4 weeks before the range
  const STREAK_BONUS_CAP_WEEKS = 4;
  const streakSeedStartWeek = Math.max(
    minWeekForPower - STREAK_BONUS_CAP_WEEKS,
    V2_START_WEEK
  );

  const cashMinerWeeks = new Set<number>();
  const seedStartTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const maxWeekEndTimestamp =
    GENESIS_TIMESTAMP + (maxWeekForPower + 1) * 604800;

  // Fetch mining-center fraction purchases for the wallet
  const miningRows = await db
    .select({
      timestamp: fractionSplits.timestamp,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        eq(fractionSplits.buyer, wallet),
        eq(fractions.type, "mining-center"),
        gte(fractionSplits.timestamp, seedStartTimestamp),
        lte(fractionSplits.timestamp, maxWeekEndTimestamp)
      )
    );

  for (const row of miningRows) {
    const week = getCurrentEpoch(row.timestamp);
    if (week >= streakSeedStartWeek && week <= maxWeekForPower) {
      cashMinerWeeks.add(week);
    }
  }

  // Fetch deposit split history for streak computation
  let splitSegments: Array<{
    farmId: string;
    startWeek: number;
    endWeek: number;
    depositSplitPercent6Decimals: string;
    paymentAmount?: string;
    paymentCurrency?: string;
  }> = [];

  try {
    const m = await fetchDepositSplitsHistoryBatch({
      wallets: [wallet],
      startWeek: streakSeedStartWeek,
      endWeek: maxWeekForPower,
    });
    splitSegments = m.get(wallet) || [];
  } catch {
    // If fetch fails, we'll compute without streak tracking
  }

  // Group split segments by farm
  const splitSegmentsByFarm = new Map<string, typeof splitSegments>();
  for (const seg of splitSegments) {
    if (!splitSegmentsByFarm.has(seg.farmId)) {
      splitSegmentsByFarm.set(seg.farmId, []);
    }
    splitSegmentsByFarm.get(seg.farmId)!.push(seg);
  }

  // Helper to get split at a specific week
  function getSplitAtWeek(farmId: string, week: number): bigint {
    const segs = splitSegmentsByFarm.get(farmId);
    if (!segs) return BigInt(0);
    for (const seg of segs) {
      if (week >= seg.startWeek && week <= seg.endWeek) {
        try {
          return BigInt(seg.depositSplitPercent6Decimals);
        } catch {
          return BigInt(0);
        }
      }
    }
    return BigInt(0);
  }

  // Get farm principal amounts (for GLW-denominated farms only for streak calculation)
  const farmPrincipals = new Map<string, bigint>();
  for (const seg of splitSegments) {
    if (
      !farmPrincipals.has(seg.farmId) &&
      seg.paymentAmount &&
      seg.paymentCurrency?.toUpperCase() === "GLW"
    ) {
      try {
        farmPrincipals.set(seg.farmId, BigInt(seg.paymentAmount));
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Compute multipliers for each week
  const multipliersByWeek = new Map<
    number,
    {
      rolloverMultiplier: number;
      hasCashMinerBonus: boolean;
      streakBonusMultiplier: number;
      impactStreakWeeks: number;
    }
  >();

  let impactStreakWeeks = 0;
  let previousGrossShareWei = BigInt(0);
  const SPLIT_SCALE = BigInt(1_000_000);

  for (let week = streakSeedStartWeek; week <= maxWeekForPower; week++) {
    const hasCashMinerBonus = cashMinerWeeks.has(week);

    // Compute gross share for streak tracking
    let grossShareWei = BigInt(0);
    for (const [farmId, principal] of farmPrincipals) {
      const splitScaled6 = getSplitAtWeek(farmId, week);
      if (splitScaled6 > BigInt(0)) {
        grossShareWei += (principal * splitScaled6) / SPLIT_SCALE;
      }
    }

    const hasImpactActionThisWeek =
      grossShareWei > previousGrossShareWei || hasCashMinerBonus;
    impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
    previousGrossShareWei = grossShareWei;

    // Compute multipliers
    const baseMultiplier = hasCashMinerBonus ? 3 : 1;
    const effectiveStreakWeeks = Math.min(
      impactStreakWeeks,
      STREAK_BONUS_CAP_WEEKS
    );
    const streakBonusMultiplier = effectiveStreakWeeks * 0.25;
    const rolloverMultiplier = baseMultiplier + streakBonusMultiplier;

    multipliersByWeek.set(week, {
      rolloverMultiplier,
      hasCashMinerBonus,
      streakBonusMultiplier,
      impactStreakWeeks,
    });
  }

  const weeklyPowerHistory: WeeklyPowerHistoryItem[] =
    weeklyPowerHistoryRows.map((row) => {
      const multiplierData = multipliersByWeek.get(row.weekNumber) || {
        rolloverMultiplier: 1,
        hasCashMinerBonus: false,
        streakBonusMultiplier: 0,
        impactStreakWeeks: 0,
      };
      return {
        weekNumber: row.weekNumber,
        regionId: row.regionId,
        directPoints: Number(row.directPoints),
        glowWorthPoints: Number(row.glowWorthPoints),
        ...multiplierData,
      };
    });

  // 9. Determine stronghold
  let strongholdRegionId: number | null = null;
  let maxWatts = 0;
  for (const [regionId, watts] of Object.entries(wattsByRegion)) {
    if (watts > maxWatts) {
      maxWatts = watts;
      strongholdRegionId = Number(regionId);
    }
  }

  // 10. Recent Drop
  let recentDrop: RecentDrop | null = null;
  if (farmsWithCapture.length > 0) {
    farmsWithCapture.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
    recentDrop = farmsWithCapture[0];
  }

  // 11. Influence stats (Use LATEST aggregate cache for UI "Top X%" ranking)
  const powerByRegion: PowerByRegion = {};

  for (const [rid, userPower] of fallbackUserPowerMap.entries()) {
    // Skip CGP for influence stats in the collector context
    if (rid === 1) continue;

    const totalNetworkPower = fallbackNetworkPowerMap.get(rid) || 0;
    const regionWallets = fallbackWalletsByRegion.get(rid) || [];

    if (totalNetworkPower <= 0 || userPower <= 0) continue;

    const sortedPowers = [...regionWallets].sort((a, b) => b - a);
    const userRank = sortedPowers.findIndex((p) => p <= userPower) + 1;
    const walletsWithLessPower = regionWallets.filter(
      (p) => p < userPower
    ).length;
    const powerPercentile =
      regionWallets.length > 0
        ? Math.round((walletsWithLessPower / regionWallets.length) * 100)
        : 0;

    powerByRegion[rid] = {
      userPower,
      totalNetworkPower,
      powerPercentile,
      rank: userRank,
      totalWallets: regionWallets.length,
    };
  }

  return {
    totalWatts,
    wattsByRegion,
    powerByRegion,
    strongholdRegionId,
    recentDrop,
    weeklyHistory,
    weeklyPowerHistory,
  };
}
