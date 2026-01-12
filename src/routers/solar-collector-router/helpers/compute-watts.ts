import { db } from "../../../db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  impactLeaderboardCacheByRegion,
} from "../../../db/schema";
import { eq, isNotNull, and } from "drizzle-orm";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../../fractions-router/helpers/apy-helpers";

export interface WattsByRegion {
  [regionId: number]: number;
}

export interface ComputeWattsResult {
  totalWatts: number;
  wattsByRegion: WattsByRegion;
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

  // 1. Fetch all finalized farms
  const finalizedFarms = await db
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

  if (finalizedFarms.length === 0) {
    return { totalWatts: 0, wattsByRegion: {} };
  }

  // 2. Get the week range for impact scores
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // 3. Fetch user's region breakdown from cache
  const userRegionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.walletAddress, wallet),
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  if (userRegionRows.length === 0) {
    console.warn(
      `[computeTotalWattsCaptured] No region cache data for wallet ${wallet}`
    );
    return { totalWatts: 0, wattsByRegion: {} };
  }

  // 4. Fetch ALL wallets' region breakdown to compute total network power per region
  const allRegionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  // 5. Group farms by region and week
  const farmsByRegionAndWeek = new Map<
    number,
    Map<number, typeof finalizedFarms>
  >();

  for (const farm of finalizedFarms) {
    const regionId = farm.regionId;
    const dropDate = farm.paymentDate || farm.createdAt;
    const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);

    if (!farmsByRegionAndWeek.has(regionId)) {
      farmsByRegionAndWeek.set(regionId, new Map());
    }
    const regionMap = farmsByRegionAndWeek.get(regionId)!;
    if (!regionMap.has(weekNumber)) {
      regionMap.set(weekNumber, []);
    }
    regionMap.get(weekNumber)!.push(farm);
  }

  // 6. Compute watts by region
  const wattsByRegion: WattsByRegion = {};

  for (const [regionId, weekMap] of farmsByRegionAndWeek.entries()) {
    // Get user's region points
    const userRegionData = userRegionRows.find((r) => r.regionId === regionId);
    if (!userRegionData) continue;

    const userDirectPoints = Number(userRegionData.directPoints);
    const userGlowWorthPoints = Number(userRegionData.glowWorthPoints);

    // Compute user's Power for this region
    // glowWorthPoints is already distributed by emission share in the cache
    const userPower = userDirectPoints + userGlowWorthPoints;

    // Compute total network Power for this region
    let totalNetworkPower = 0;
    for (const row of allRegionRows) {
      if (row.regionId !== regionId) continue;
      const directPoints = Number(row.directPoints);
      const glowWorthPoints = Number(row.glowWorthPoints);
      totalNetworkPower += directPoints + glowWorthPoints;
    }

    if (totalNetworkPower <= 0 || userPower <= 0) continue;

    // Calculate watts for this region
    let regionWatts = 0;
    for (const farms of weekMap.values()) {
      for (const farm of farms) {
        // Parse capacity from systemWattageOutput (e.g., "10.5 kW" -> 10500 watts)
        let capacityWatts = 0;
        const wattageOutputStr = farm.systemWattageOutput || "";
        const match = wattageOutputStr.match(/([\d.]+)/);
        if (match) {
          const kW = parseFloat(match[1]);
          if (!Number.isNaN(kW)) capacityWatts = kW * 1000;
        }

        // WattsReceived = FarmCapacity × (UserPower / TotalNetworkPower)
        regionWatts += capacityWatts * (userPower / totalNetworkPower);
      }
    }

    wattsByRegion[regionId] = regionWatts;
  }

  // 7. Sum all regions to get total watts
  const totalWatts = Object.values(wattsByRegion).reduce(
    (sum, watts) => sum + watts,
    0
  );

  return { totalWatts, wattsByRegion };
}
