/**
 * Debug watts distribution for a specific farm
 * Shows how farm capacity is distributed to all wallets based on their regional power
 * 
 * Usage:
 *   bun run scripts/debug-farm-watts-distribution.ts "Lichen Headland"
 */

import { db } from "../src/db/db";
import {
  farms,
  applications,
  applicationsAuditFieldsCRS,
  impactLeaderboardCacheByRegion,
} from "../src/db/schema";
import { eq, isNotNull, and, like } from "drizzle-orm";
import { getCurrentEpoch } from "../src/utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";

const WATTS_PER_PANEL = 400;

async function debugFarmDistribution(farmNamePattern: string) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`🔍 Farm Watts Distribution: ${farmNamePattern}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // 1. Find the farm
  const farmResults = await db
    .select({
      farmId: farms.id,
      farmName: farms.name,
      regionId: farms.zoneId,
      createdAt: farms.createdAt,
      systemWattageOutput: applicationsAuditFieldsCRS.systemWattageOutput,
      paymentDate: applications.paymentDate,
      protocolFeePaymentHash: farms.protocolFeePaymentHash,
    })
    .from(farms)
    .innerJoin(applications, eq(farms.id, applications.farmId))
    .leftJoin(
      applicationsAuditFieldsCRS,
      eq(applications.id, applicationsAuditFieldsCRS.applicationId)
    )
    .where(
      and(
        like(farms.name, `%${farmNamePattern}%`),
        isNotNull(farms.protocolFeePaymentHash)
      )
    );

  if (farmResults.length === 0) {
    console.log("❌ No finalized farm found matching:", farmNamePattern);
    process.exit(1);
  }

  const farm = farmResults[0];
  const dropDate = farm.paymentDate || farm.createdAt;
  const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);

  // Parse farm capacity
  let capacityWatts = 0;
  const wattageOutputStr = farm.systemWattageOutput || "";
  const match = wattageOutputStr.match(/([\d.]+)/);
  if (match) {
    const kW = parseFloat(match[1]);
    if (!Number.isNaN(kW)) capacityWatts = kW * 1000;
  }

  console.log(`📋 Farm Details:`);
  console.log(`   Name: ${farm.farmName}`);
  console.log(`   ID: ${farm.farmId}`);
  console.log(`   Region: ${farm.regionId}`);
  console.log(`   Capacity: ${(capacityWatts / 1000).toFixed(1)}kW (${capacityWatts.toLocaleString()}W)`);
  console.log(`   Finalized: Week ${weekNumber}`);
  console.log(`   Drop Date: ${dropDate.toISOString().split('T')[0]}`);
  console.log("");

  // 2. Get region data for the farm's drop week
  const { startWeek, endWeek } = getWeekRangeForImpact();
  
  console.log(`📅 Using impact week range: ${startWeek} - ${endWeek}`);
  console.log(`   (Farm dropped in week ${weekNumber})\n`);

  // Get all wallets' power in this region
  const regionRows = await db
    .select()
    .from(impactLeaderboardCacheByRegion)
    .where(
      and(
        eq(impactLeaderboardCacheByRegion.regionId, farm.regionId),
        eq(impactLeaderboardCacheByRegion.startWeek, startWeek),
        eq(impactLeaderboardCacheByRegion.endWeek, endWeek)
      )
    );

  console.log(`🌍 Region ${farm.regionId} has ${regionRows.length} active wallets\n`);

  // Calculate power distribution
  interface WalletPower {
    wallet: string;
    directPoints: number;
    glowWorthPoints: number;
    totalPower: number;
    sharePercent: number;
    wattsCaptured: number;
    panelsCaptured: number;
  }

  const walletPowers: WalletPower[] = [];
  let totalNetworkPower = 0;

  for (const row of regionRows) {
    const directPoints = Number(row.directPoints);
    const glowWorthPoints = Number(row.glowWorthPoints);
    const totalPower = directPoints + glowWorthPoints;
    totalNetworkPower += totalPower;
  }

  for (const row of regionRows) {
    const directPoints = Number(row.directPoints);
    const glowWorthPoints = Number(row.glowWorthPoints);
    const totalPower = directPoints + glowWorthPoints;
    const sharePercent = (totalPower / totalNetworkPower) * 100;
    const wattsCaptured = capacityWatts * (totalPower / totalNetworkPower);
    const panelsCaptured = wattsCaptured / WATTS_PER_PANEL;

    walletPowers.push({
      wallet: row.walletAddress,
      directPoints,
      glowWorthPoints,
      totalPower,
      sharePercent,
      wattsCaptured,
      panelsCaptured,
    });
  }

  // Sort by watts captured descending
  walletPowers.sort((a, b) => b.wattsCaptured - a.wattsCaptured);

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📊 WATTS DISTRIBUTION TO WALLETS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log(`Total Network Power in Region ${farm.regionId}: ${totalNetworkPower.toLocaleString()}\n`);

  let distributedWatts = 0;

  walletPowers.forEach((wp, idx) => {
    distributedWatts += wp.wattsCaptured;
    
    console.log(`${(idx + 1).toString().padStart(3)}. ${wp.wallet}`);
    console.log(`     Power: ${wp.totalPower.toLocaleString().padStart(15)} (${wp.directPoints.toLocaleString()} direct + ${wp.glowWorthPoints.toLocaleString()} worth)`);
    console.log(`     Share: ${wp.sharePercent.toFixed(4)}%`);
    console.log(`     Watts: ${wp.wattsCaptured.toFixed(2).padStart(10)}W (${wp.panelsCaptured.toFixed(4)} panels)`);
    console.log("");
  });

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎯 DISTRIBUTION SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log(`Farm Capacity: ${capacityWatts.toFixed(2)}W`);
  console.log(`Total Distributed: ${distributedWatts.toFixed(2)}W`);
  console.log(`Difference: ${(capacityWatts - distributedWatts).toFixed(2)}W`);
  console.log(`Distributed to ${walletPowers.length} wallets\n`);

  // Show top 10
  console.log("🏆 Top 10 Captors:");
  walletPowers.slice(0, 10).forEach((wp, idx) => {
    const shortAddr = wp.wallet.slice(0, 6) + "..." + wp.wallet.slice(-4);
    console.log(`   ${(idx + 1).toString().padStart(2)}. ${shortAddr}: ${wp.wattsCaptured.toFixed(2)}W (${wp.sharePercent.toFixed(2)}%)`);
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

const farmNameArg = process.argv[2];
if (!farmNameArg) {
  console.error("❌ Error: Please provide a farm name");
  console.log("\nUsage:");
  console.log('  bun run scripts/debug-farm-watts-distribution.ts "Lichen Headland"');
  process.exit(1);
}

debugFarmDistribution(farmNameArg).catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
