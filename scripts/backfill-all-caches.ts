import { getProtocolWeek } from "../src/utils/getProtocolWeek";
import { updatePowerByRegionByWeek } from "../src/crons/update-power-by-region-by-week/update-power-by-region-by-week";
import { updateImpactLeaderboard } from "../src/crons/update-impact-leaderboard/update-impact-leaderboard";
import { updateImpactLeaderboardByRegion } from "../src/crons/update-impact-leaderboard-by-region/update-impact-leaderboard-by-region";

async function main() {
  console.log("🚀 Starting backfill of ALL caches...\n");

  const results: { name: string; updated: number; durationMs: number }[] = [];

  // 1. Weekly Power by Region
  console.log("━".repeat(50));
  console.log("1️⃣  Weekly Power by Region");
  console.log("━".repeat(50));
  try {
    const currentWeek = getProtocolWeek();
    const startWeek = 97;
    const endWeek = currentWeek - 1;
    console.log(`   Week range: ${startWeek} → ${endWeek}`);

    const start = Date.now();
    const result = await updatePowerByRegionByWeek({ startWeek, endWeek });
    const durationMs = Date.now() - start;

    results.push({ name: "Weekly Power", updated: result.updated, durationMs });
    console.log(`   ✅ Updated ${result.updated} rows in ${(durationMs / 1000).toFixed(1)}s\n`);
  } catch (error) {
    console.error("   ❌ Failed:", error);
    process.exit(1);
  }

  // 2. Impact Leaderboard (global)
  console.log("━".repeat(50));
  console.log("2️⃣  Impact Leaderboard (global)");
  console.log("━".repeat(50));
  try {
    const start = Date.now();
    const result = await updateImpactLeaderboard();
    const durationMs = Date.now() - start;

    results.push({ name: "Impact Leaderboard", updated: result.updated, durationMs });
    console.log(`   ✅ Updated ${result.updated} rows in ${(durationMs / 1000).toFixed(1)}s\n`);
  } catch (error) {
    console.error("   ❌ Failed:", error);
    process.exit(1);
  }

  // 3. Impact Leaderboard by Region
  console.log("━".repeat(50));
  console.log("3️⃣  Impact Leaderboard by Region");
  console.log("━".repeat(50));
  try {
    const start = Date.now();
    const result = await updateImpactLeaderboardByRegion();
    const durationMs = Date.now() - start;

    results.push({ name: "Impact by Region", updated: result.updated, durationMs });
    console.log(`   ✅ Updated ${result.updated} rows in ${(durationMs / 1000).toFixed(1)}s\n`);
  } catch (error) {
    console.error("   ❌ Failed:", error);
    process.exit(1);
  }

  // Summary
  console.log("━".repeat(50));
  console.log("📊 SUMMARY");
  console.log("━".repeat(50));
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);

  for (const r of results) {
    console.log(`   ${r.name}: ${r.updated} rows (${(r.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log("─".repeat(50));
  console.log(`   TOTAL: ${totalUpdated} rows in ${(totalDuration / 1000).toFixed(1)}s`);
  console.log("\n✅ All caches backfilled successfully!");

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
