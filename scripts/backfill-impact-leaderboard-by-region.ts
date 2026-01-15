
import { updateImpactLeaderboardByRegion } from "../src/crons/update-impact-leaderboard-by-region/update-impact-leaderboard-by-region";

async function main() {
  console.log("🚀 Starting backfill of impact leaderboard by region...");
  
  try {
    const result = await updateImpactLeaderboardByRegion();
    console.log(`✅ Backfill complete! Updated ${result.updated} rows.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Backfill failed:", error);
    process.exit(1);
  }
}

main();
