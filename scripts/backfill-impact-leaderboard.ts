
import { updateImpactLeaderboard } from "../src/crons/update-impact-leaderboard/update-impact-leaderboard";

async function main() {
  console.log("🚀 Starting backfill of impact leaderboard...");
  
  try {
    const result = await updateImpactLeaderboard();
    console.log(`✅ Backfill complete! Updated ${result.updated} rows.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Backfill failed:", error);
    process.exit(1);
  }
}

main();
