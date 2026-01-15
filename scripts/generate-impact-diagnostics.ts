/**
 * Expanded diagnostic script to include full weekly power history
 *
 * FALLBACK LOGIC (matching compute-watts.ts):
 * - If weekly snapshot exists for week-region → use it
 * - If NO network data for week-region (data gap) → use fallback from aggregate cache
 * - If network data EXISTS but user has no row → user had 0 power (not participating)
 */
import { db } from "../src/db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  powerByRegionByWeek,
  impactLeaderboardCacheByRegion,
} from "../src/db/schema";
import { eq, isNotNull, and, inArray, sql, gte, lte } from "drizzle-orm";
import { getCurrentEpoch } from "../src/utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";
import { writeFileSync } from "fs";

const V2_START_WEEK = 97;

async function generateExpandedBreakdown(walletAddress: string) {
  const wallet = walletAddress.toLowerCase();
  const { startWeek, endWeek } = getWeekRangeForImpact();

  console.log(`🚀 Generating expanded breakdown for: ${wallet}...`);

  // 1. Fetch all weekly power records for this wallet (EXCLUDING REGION 1)
  const powerHistory = await db
    .select()
    .from(powerByRegionByWeek)
    .where(
      and(
        eq(powerByRegionByWeek.walletAddress, wallet),
        sql`${powerByRegionByWeek.regionId} != 1`,
        gte(powerByRegionByWeek.weekNumber, V2_START_WEEK),
        lte(powerByRegionByWeek.weekNumber, endWeek)
      )
    )
    .orderBy(powerByRegionByWeek.weekNumber);

  // 2. Fetch network totals for the same range (EXCLUDING REGION 1)
  const networkHistory = await db
    .select({
      weekNumber: powerByRegionByWeek.weekNumber,
      regionId: powerByRegionByWeek.regionId,
      totalDirect: sql<string>`SUM(direct_points)`,
      totalWorth: sql<string>`SUM(glow_worth_points)`,
      totalPower: sql<string>`SUM(direct_points + glow_worth_points)`,
    })
    .from(powerByRegionByWeek)
    .where(
      and(
        sql`${powerByRegionByWeek.regionId} != 1`,
        gte(powerByRegionByWeek.weekNumber, V2_START_WEEK),
        lte(powerByRegionByWeek.weekNumber, endWeek)
      )
    )
    .groupBy(powerByRegionByWeek.weekNumber, powerByRegionByWeek.regionId);

  // 2.5 Fetch latest aggregate power as fallback (in case weekly snapshots are missing)
  // This matches the logic in compute-watts.ts
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

  for (const row of fallbackRegionRows) {
    const rid = row.regionId;
    if (rid === 1) continue; // Exclude CGP
    const power = Number(row.directPoints) + Number(row.glowWorthPoints);
    if (row.walletAddress.toLowerCase() === wallet) {
      fallbackUserPowerMap.set(rid, power);
    }
    fallbackNetworkPowerMap.set(
      rid,
      (fallbackNetworkPowerMap.get(rid) || 0) + power
    );
  }

  console.log(
    `📊 Fallback power available for ${fallbackUserPowerMap.size} region(s)`
  );

  // 3. Fetch farms
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

  const v2Farms = allFinalizedFarms.filter((farm) => {
    // Exclude CGP (region 1) farms
    if (farm.regionId === 1) return false;
    const dropDate = farm.paymentDate || farm.createdAt;
    const week = getCurrentEpoch(dropDate.getTime() / 1000);
    return week >= V2_START_WEEK && week <= endWeek;
  });

  // 4. Map data with correct fallback logic matching compute-watts.ts
  const farmsData = v2Farms.map((f) => {
    const dropDate = f.paymentDate || f.createdAt;
    const week = getCurrentEpoch(dropDate.getTime() / 1000);
    const p = powerHistory.find(
      (ph) => ph.weekNumber === week && ph.regionId === f.regionId
    );
    const net = networkHistory.find(
      (nh) => nh.weekNumber === week && nh.regionId === f.regionId
    );

    let capacityWatts = 0;
    const match = (f.systemWattageOutput || "").match(/([\d.]+)/);
    if (match) capacityWatts = parseFloat(match[1]) * 1000;

    // Check if network data exists for this week-region
    // This tells us if the week has been populated (vs being a data gap)
    const hasNetworkDataForWeek = !!net;

    // FALLBACK LOGIC:
    // - If weekly snapshot exists → use it
    // - If NO network data for this week-region (data gap) → use fallback
    // - If network data EXISTS but user has no row → user had 0 power (not participating)
    const userPower = p
      ? Number(p.directPoints) + Number(p.glowWorthPoints)
      : hasNetworkDataForWeek
      ? 0 // Network has data but user doesn't → user had 0 power
      : fallbackUserPowerMap.get(f.regionId) || 0; // No data at all → fallback

    const netPower = hasNetworkDataForWeek
      ? Number(net.totalPower)
      : fallbackNetworkPowerMap.get(f.regionId) || 0;

    const share = netPower > 0 ? userPower / netPower : 0;
    const usedFallback = !hasNetworkDataForWeek && netPower > 0;

    return {
      farmName: f.farmName,
      regionId: f.regionId,
      weekNumber: week,
      finalizedAt: dropDate.toISOString(),
      capacityWatts,
      userPower,
      networkPower: netPower,
      wattsCaptured: capacityWatts * share,
      usedFallback,
      hadZeroPower: hasNetworkDataForWeek && !p,
    };
  });

  const totalWatts = farmsData.reduce((sum, f) => sum + f.wattsCaptured, 0);
  const farmsUsingFallback = farmsData.filter((f) => f.usedFallback).length;
  const farmsWithZeroPower = farmsData.filter((f) => f.hadZeroPower).length;
  const farmsWithSnapshots =
    farmsData.length - farmsUsingFallback - farmsWithZeroPower;
  const regionTotals: Record<number, number> = {};
  farmsData.forEach((f) => {
    regionTotals[f.regionId] =
      (regionTotals[f.regionId] || 0) + f.wattsCaptured;
  });

  console.log(`📊 Total farms: ${farmsData.length}`);
  console.log(`   └─ Using weekly snapshots: ${farmsWithSnapshots}`);
  console.log(
    `   └─ User had 0 power (not participating): ${farmsWithZeroPower}`
  );
  console.log(`   └─ Using fallback (data gap): ${farmsUsingFallback}`);

  const resultData = {
    walletAddress: wallet,
    generatedAt: new Date().toISOString(),
    summary: {
      totalWatts: Math.round(totalWatts),
      totalPanels: Math.floor(totalWatts / 400),
      farmsCount: farmsData.length,
      farmsWithSnapshots,
      farmsWithZeroPower,
      farmsUsingFallback,
      regionTotals: Object.fromEntries(
        Object.entries(regionTotals).map(([rid, watts]) => [
          rid,
          Math.round(watts),
        ])
      ),
    },
    weeks: powerHistory.map((p) => {
      const net = networkHistory.find(
        (n) => n.weekNumber === p.weekNumber && n.regionId === p.regionId
      );
      return {
        weekNumber: p.weekNumber,
        regionId: p.regionId,
        inflationPoints: Number(p.inflationPoints),
        steeringPoints: Number(p.steeringPoints),
        vaultBonusPoints: Number(p.vaultBonusPoints),
        glowWorthPoints: Number(p.glowWorthPoints),
        totalPoints: Number(p.directPoints) + Number(p.glowWorthPoints),
        networkTotalPower: net ? Number(net.totalPower) : 0,
        sharePercent: net
          ? ((Number(p.directPoints) + Number(p.glowWorthPoints)) /
              Number(net.totalPower)) *
            100
          : 0,
      };
    }),
    farms: farmsData,
  };

  writeFileSync(
    "solar_footprint_data.json",
    JSON.stringify(resultData, null, 2)
  );
  console.log("✅ Updated solar_footprint_data.json with full points history");
}

const walletArg = process.argv[2];
if (!walletArg) process.exit(1);
generateExpandedBreakdown(walletArg).catch(console.error);
