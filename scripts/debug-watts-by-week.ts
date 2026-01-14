/**
 * Debug script to verify watts distribution per week for a specific region
 * Usage: bun run scripts/debug-watts-by-week.ts <walletAddress> [regionId]
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

const walletAddress = process.argv[2]?.toLowerCase();
const targetRegionId = process.argv[3] ? parseInt(process.argv[3], 10) : 4; // Default to Colorado

if (!walletAddress) {
  console.error("Usage: bun run scripts/debug-watts-by-week.ts <walletAddress> [regionId]");
  process.exit(1);
}

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`🔍 Watts Verification for Region ${targetRegionId}`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const { startWeek, endWeek } = getWeekRangeForImpact();
  console.log(`📅 Impact week range: ${startWeek} - ${endWeek}\n`);

  // Get all finalized farms in target region
  const allFarms = await db
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
    .where(
      and(
        isNotNull(farms.protocolFeePaymentHash),
        eq(farms.zoneId, targetRegionId)
      )
    );

  // Filter to V2 farms in completed weeks
  const V2_START_WEEK = 97;
  const farmsWithWeeks = allFarms
    .map((farm) => {
      const dropDate = farm.paymentDate || farm.createdAt;
      const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
      return { ...farm, weekNumber };
    })
    .filter((f) => f.weekNumber >= V2_START_WEEK && f.weekNumber <= endWeek)
    .sort((a, b) => a.weekNumber - b.weekNumber);

  console.log(`Found ${farmsWithWeeks.length} V2 farms in Region ${targetRegionId}\n`);

  // Get user's power by region (from cache) - must match week range
  const userCache = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.walletAddress, walletAddress),
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  const userRegionData = userCache.find((c) => c.regionId === targetRegionId);

  if (!userRegionData) {
    console.log("❌ User has no cached power in this region for weeks", startWeek, "-", endWeek);
    process.exit(0);
  }

  // Get ALL wallets' power for this region to calculate totals
  const allRegionCache = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.regionId, targetRegionId),
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  // Calculate total network power for this region
  let totalNetworkPower = 0;
  for (const entry of allRegionCache) {
    const direct = Number(entry.directPoints || 0);
    const worth = Number(entry.glowWorthPoints || 0);
    totalNetworkPower += direct + worth;
  }

  const userDirect = Number(userRegionData.directPoints || 0);
  const userWorth = Number(userRegionData.glowWorthPoints || 0);
  const userPower = userDirect + userWorth;
  const userSharePercent = (userPower / totalNetworkPower) * 100;

  console.log("📊 User's Regional Power:");
  console.log(`   Direct Points: ${userDirect.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`   Worth Points: ${userWorth.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`   Total Power: ${userPower.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`   Network Total: ${totalNetworkPower.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`   User Share: ${userSharePercent.toFixed(4)}%\n`);

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📈 FARM-BY-FARM VERIFICATION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  let totalWattsCalculated = 0;

  for (const farm of farmsWithWeeks) {
    // Parse farm capacity
    const wattageStr = farm.systemWattageOutput || "";
    const match = wattageStr.match(/([\d.]+)/);
    let capacityWatts = 0;
    if (match) {
      const kW = parseFloat(match[1]);
      if (!Number.isNaN(kW)) capacityWatts = kW * 1000;
    }

    // Calculate expected watts based on user's share
    const expectedWatts = capacityWatts * (userPower / totalNetworkPower);
    totalWattsCalculated += expectedWatts;

    console.log(`🏠 ${farm.farmName}`);
    console.log(`   Farm ID: ${farm.farmId.substring(0, 8)}...`);
    console.log(`   Week: ${farm.weekNumber}`);
    console.log(`   Farm Capacity: ${(capacityWatts / 1000).toFixed(1)} kW (${capacityWatts}W)`);
    console.log(`   Your Share: ${userSharePercent.toFixed(4)}%`);
    console.log(`   Expected Watts: ${expectedWatts.toFixed(2)}W`);
    console.log("");
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎯 SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const totalCapacity = farmsWithWeeks.reduce((sum, f) => {
    const wattageStr = f.systemWattageOutput || "";
    const match = wattageStr.match(/([\d.]+)/);
    if (match) {
      const kW = parseFloat(match[1]);
      if (!Number.isNaN(kW)) return sum + kW * 1000;
    }
    return sum;
  }, 0);

  console.log(`Total Farm Capacity in Region: ${(totalCapacity / 1000).toFixed(1)} kW`);
  console.log(`Your Share of Region: ${userSharePercent.toFixed(4)}%`);
  console.log(`Total Watts You Should Capture: ${totalWattsCalculated.toFixed(2)}W`);
  console.log(`   = ${(totalWattsCalculated / 1000).toFixed(2)} kW`);
  console.log(`   = ${(totalWattsCalculated / 400).toFixed(2)} panels\n`);

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
