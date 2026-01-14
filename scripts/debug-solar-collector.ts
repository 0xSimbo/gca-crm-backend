/**
 * Debug Solar Collector calculation for a specific wallet
 * 
 * Usage:
 *   bun run scripts/debug-solar-collector.ts 0x77f41144E787CB8Cd29A37413A71F53f92ee050C
 */

import { db } from "../src/db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  impactLeaderboardCacheByRegion,
} from "../src/db/schema";
import { eq, isNotNull, and } from "drizzle-orm";
import { getCurrentEpoch } from "../src/utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";

const WATTS_PER_PANEL = 400;
const V2_START_WEEK = 97;

async function debugSolarCollector(walletAddress: string) {
  const wallet = walletAddress.toLowerCase();
  
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`🔍 Solar Collector Debug for: ${wallet}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

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

  console.log(`📊 Total finalized farms in DB: ${allFinalizedFarms.length}`);

  // Get week range for impact (completed weeks only)
  const { startWeek, endWeek } = getWeekRangeForImpact();

  // Filter to v2 farms from COMPLETED weeks only
  // We can't distribute watts for current week farms because power is still changing
  const v2Farms = allFinalizedFarms.filter((farm) => {
    const dropDate = farm.paymentDate || farm.createdAt;
    const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
    return weekNumber >= V2_START_WEEK && weekNumber <= endWeek;
  });

  const v1Farms = allFinalizedFarms.length - v2Farms.length;
  const currentWeekFarms = allFinalizedFarms.filter((farm) => {
    const dropDate = farm.paymentDate || farm.createdAt;
    const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
    return weekNumber > endWeek;
  }).length;

  console.log(`   └─ V2 farms in completed weeks (${V2_START_WEEK}-${endWeek}): ${v2Farms.length}`);
  console.log(`   └─ Current week farms (excluded, pending): ${currentWeekFarms}`);
  console.log(`   └─ V1 farms (excluded): ${v1Farms}\n`);

  console.log(`📅 Impact week range: ${startWeek} - ${endWeek} (completed weeks only)\n`);

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
    console.log("❌ No region cache data found for this wallet");
    process.exit(0);
  }

  console.log(`🌍 User has power in ${userRegionRows.length} region(s):`);
  userRegionRows.forEach((row) => {
    const directPoints = Number(row.directPoints);
    const glowWorthPoints = Number(row.glowWorthPoints);
    const totalPower = directPoints + glowWorthPoints;
    console.log(`   Region ${row.regionId}: ${totalPower.toLocaleString()} power (${directPoints.toLocaleString()} direct + ${glowWorthPoints.toLocaleString()} worth)`);
  });
  console.log("");

  // 3. Get all region data for network totals
  const allRegionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  // Calculate network power per region
  const networkPowerByRegion = new Map<number, number>();
  for (const row of allRegionRows) {
    const regionId = row.regionId;
    const power = Number(row.directPoints) + Number(row.glowWorthPoints);
    networkPowerByRegion.set(
      regionId,
      (networkPowerByRegion.get(regionId) || 0) + power
    );
  }

  // 4. Group farms by region
  const farmsByRegion = new Map<number, typeof v2Farms>();
  for (const farm of v2Farms) {
    const regionId = farm.regionId;
    if (!farmsByRegion.has(regionId)) {
      farmsByRegion.set(regionId, []);
    }
    farmsByRegion.get(regionId)!.push(farm);
  }

  // 5. Calculate watts per region
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📈 WATTS BREAKDOWN BY REGION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  let totalWatts = 0;
  const wattsByRegion = new Map<number, number>();

  // Check ALL regions where user has power, even if no farms
  for (const userRegionData of userRegionRows) {
    const regionId = userRegionData.regionId;
    const farms = farmsByRegion.get(regionId) || [];

    const userDirectPoints = Number(userRegionData.directPoints);
    const userGlowWorthPoints = Number(userRegionData.glowWorthPoints);
    const userPower = userDirectPoints + userGlowWorthPoints;
    const totalNetworkPower = networkPowerByRegion.get(regionId) || 0;

    if (totalNetworkPower <= 0 || userPower <= 0) continue;

    const sharePercent = (userPower / totalNetworkPower) * 100;

    console.log(`\n🌎 REGION ${regionId}`);
    console.log(`   User Power: ${userPower.toLocaleString()}`);
    console.log(`   Network Power: ${totalNetworkPower.toLocaleString()}`);
    console.log(`   User Share: ${sharePercent.toFixed(4)}%`);
    console.log(`   Farms in region: ${farms.length}`);
    
    if (farms.length === 0) {
      console.log(`   ⚠️  No V2 farms in this region yet\n`);
      continue;
    }
    console.log("");

    let regionWatts = 0;
    farms.forEach((farm, idx) => {
      const dropDate = farm.paymentDate || farm.createdAt;
      const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
      
      // Parse capacity
      let capacityWatts = 0;
      const wattageOutputStr = farm.systemWattageOutput || "";
      const match = wattageOutputStr.match(/([\d.]+)/);
      if (match) {
        const kW = parseFloat(match[1]);
        if (!Number.isNaN(kW)) capacityWatts = kW * 1000;
      }

      const wattsCaptured = capacityWatts * (userPower / totalNetworkPower);
      regionWatts += wattsCaptured;

      console.log(`   ${idx + 1}. ${farm.farmName || "Unknown"} (${farm.farmId.slice(0, 8)}...)`);
      console.log(`      Week: ${weekNumber} | Capacity: ${(capacityWatts / 1000).toFixed(1)}kW`);
      console.log(`      You captured: ${wattsCaptured.toFixed(2)}W`);
    });

    wattsByRegion.set(regionId, regionWatts);
    totalWatts += regionWatts;

    console.log(`\n   ✅ Region ${regionId} Total: ${regionWatts.toFixed(2)}W (${(regionWatts / WATTS_PER_PANEL).toFixed(2)} panels)`);
  }

  // 6. Summary
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎯 FINAL SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const roundedTotalWatts = Math.round(totalWatts);
  const totalPanels = Math.floor(roundedTotalWatts / WATTS_PER_PANEL);
  const currentGhostWatts = roundedTotalWatts % WATTS_PER_PANEL;
  const ghostProgress = (currentGhostWatts / WATTS_PER_PANEL) * 100;

  console.log(`Total Watts (raw): ${totalWatts.toFixed(2)}W`);
  console.log(`Total Watts (rounded): ${roundedTotalWatts.toLocaleString()}W`);
  console.log(`\n📦 Completed Panels: ${totalPanels}`);
  console.log(`⚡ Current Panel Progress: ${currentGhostWatts}W / ${WATTS_PER_PANEL}W (${ghostProgress.toFixed(1)}%)`);
  console.log(`🎯 Working on Panel #${totalPanels + 1}`);
  
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

const walletArg = process.argv[2];
if (!walletArg) {
  console.error("❌ Error: Please provide a wallet address");
  console.log("\nUsage:");
  console.log("  bun run scripts/debug-solar-collector.ts 0x...");
  process.exit(1);
}

debugSolarCollector(walletArg).catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
