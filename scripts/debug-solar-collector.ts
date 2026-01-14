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
  powerByRegionByWeek,
} from "../src/db/schema";
import { eq, isNotNull, and, inArray, sql } from "drizzle-orm";
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

  console.log(
    `   └─ V2 farms in completed weeks (${V2_START_WEEK}-${endWeek}): ${v2Farms.length}`
  );
  console.log(
    `   └─ Current week farms (excluded, pending): ${currentWeekFarms}`
  );
  console.log(`   └─ V1 farms (excluded): ${v1Farms}\n`);

  console.log(
    `📅 Impact week range: ${startWeek} - ${endWeek} (completed weeks only)\n`
  );

  // 2. Fetch latest aggregate power as fallback (in case weekly snapshots are missing)
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

  // 3. Identify all weeks where farms went live
  const farmWeeks = Array.from(
    new Set(
      v2Farms.map((f) => {
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
        inArray(powerByRegionByWeek.weekNumber, farmWeeks)
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
    .where(inArray(powerByRegionByWeek.weekNumber, farmWeeks))
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

  console.log(
    `🌍 User has power in ${fallbackUserPowerMap.size} region(s) (LATEST CACHE):`
  );
  fallbackUserPowerMap.forEach((power, rid) => {
    console.log(`   Region ${rid}: ${power.toLocaleString()} power`);
  });
  console.log("");

  // 7. Group farms by region
  const farmsByRegion = new Map<number, typeof v2Farms>();
  for (const farm of v2Farms) {
    const regionId = farm.regionId;
    if (!farmsByRegion.has(regionId)) {
      farmsByRegion.set(regionId, []);
    }
    farmsByRegion.get(regionId)!.push(farm);
  }

  // 8. Calculate watts per region
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📈 WATTS BREAKDOWN BY REGION (WEEK-BY-WEEK)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  let totalWatts = 0;
  const wattsByRegion = new Map<number, number>();

  // Check ALL regions where user has power, even if no farms
  for (const [regionId, latestUserPower] of fallbackUserPowerMap.entries()) {
    if (regionId === 1) continue; // EXCLUDE Region 1 (CGP)

    const farms = farmsByRegion.get(regionId) || [];
    if (farms.length === 0) continue;

    console.log(`\n🌎 REGION ${regionId}`);

    let regionWatts = 0;
    farms.forEach((farm, idx) => {
      const dropDate = farm.paymentDate || farm.createdAt;
      const weekNumber = getCurrentEpoch(dropDate.getTime() / 1000);
      const key = `${weekNumber}-${regionId}`;

      // Prefer weekly snapshot, fall back to latest aggregate
      const userPower = userPowerMap.has(key)
        ? userPowerMap.get(key)!
        : latestUserPower;

      const totalNetworkPower = networkPowerMap.has(key)
        ? networkPowerMap.get(key)!
        : fallbackNetworkPowerMap.get(regionId) || 0;

      if (totalNetworkPower <= 0 || userPower <= 0) {
        console.log(
          `   ${idx + 1}. ${farm.farmName || "Unknown"} (SKIP: Power=0)`
        );
        return;
      }

      const sharePercent = (userPower / totalNetworkPower) * 100;

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

      console.log(
        `   ${idx + 1}. ${farm.farmName || "Unknown"} (${farm.farmId.slice(
          0,
          8
        )}...)`
      );
      console.log(
        `      Week: ${weekNumber} | Share: ${sharePercent.toFixed(
          4
        )}% | Capacity: ${(capacityWatts / 1000).toFixed(1)}kW`
      );
      console.log(`      You captured: ${wattsCaptured.toFixed(2)}W`);
    });

    wattsByRegion.set(regionId, regionWatts);
    totalWatts += regionWatts;

    console.log(
      `\n   ✅ Region ${regionId} Total: ${regionWatts.toFixed(2)}W (${(
        regionWatts / WATTS_PER_PANEL
      ).toFixed(2)} panels)`
    );
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
  console.log(
    `⚡ Current Panel Progress: ${currentGhostWatts}W / ${WATTS_PER_PANEL}W (${ghostProgress.toFixed(
      1
    )}%)`
  );
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
