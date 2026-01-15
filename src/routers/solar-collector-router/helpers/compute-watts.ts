import { db } from "../../../db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  powerByRegionByWeek,
  impactLeaderboardCacheByRegion,
} from "../../../db/schema";
import { eq, isNotNull, and, inArray, sql } from "drizzle-orm";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../../fractions-router/helpers/apy-helpers";

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

export interface ComputeWattsResult {
  totalWatts: number;
  wattsByRegion: WattsByRegion;
  powerByRegion: PowerByRegion;
  strongholdRegionId: number | null;
  recentDrop: RecentDrop | null;
  weeklyHistory: WeeklyHistoryItem[];
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
  walletAddress: string
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
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 2.5 Fetch latest aggregate power as fallback (in case weekly snapshots are missing)
  const fallbackRegionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
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
    return weekNumber >= V2_START_WEEK && weekNumber <= endWeek;
  });

  if (finalizedFarms.length === 0) {
    return {
      totalWatts: 0,
      wattsByRegion: {},
      powerByRegion: {},
      strongholdRegionId: null,
      recentDrop: null,
      weeklyHistory: [],
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
  };
}
