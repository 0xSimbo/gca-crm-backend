/**
 * Expanded diagnostic script to include full weekly power history
 */
import { db } from "../src/db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  powerByRegionByWeek,
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

  // 3. Fetch farms (same as before)
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
    const dropDate = farm.paymentDate || farm.createdAt;
    const week = getCurrentEpoch(dropDate.getTime() / 1000);
    return week >= V2_START_WEEK && week <= endWeek;
  });

  // 4. Map data
  const resultData = {
    walletAddress: wallet,
    generatedAt: new Date().toISOString(),
    weeks: powerHistory.map((p) => {
      const net = networkHistory.find(
        (n) => n.weekNumber === p.weekNumber && n.regionId === p.regionId
      );
      return {
        weekNumber: p.weekNumber,
        regionId: p.regionId,
        directPoints: Number(p.directPoints),
        worthPoints: Number(p.glowWorthPoints),
        totalPoints: Number(p.directPoints) + Number(p.glowWorthPoints),
        networkTotalPower: net ? Number(net.totalPower) : 0,
        sharePercent: net
          ? ((Number(p.directPoints) + Number(p.glowWorthPoints)) /
              Number(net.totalPower)) *
            100
          : 0,
      };
    }),
    farms: v2Farms.map((f) => {
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

      const userPower = p
        ? Number(p.directPoints) + Number(p.glowWorthPoints)
        : 0;
      const netPower = net ? Number(net.totalPower) : 0;
      const share = netPower > 0 ? userPower / netPower : 0;

      return {
        farmName: f.farmName,
        regionId: f.regionId,
        weekNumber: week,
        finalizedAt: dropDate.toISOString(),
        capacityWatts,
        userPower,
        networkPower: netPower,
        wattsCaptured: capacityWatts * share,
      };
    }),
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
