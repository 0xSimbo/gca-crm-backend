import { getProtocolWeek } from "../src/utils/getProtocolWeek";
import { updatePowerByRegionByWeek } from "../src/crons/update-power-by-region-by-week/update-power-by-region-by-week";

async function main() {
  const currentWeek = getProtocolWeek();
  const startWeek = 97;
  const endWeek = currentWeek - 1;

  console.log(`🚀 Starting backfill of weekly power from week ${startWeek} to ${endWeek}...`);
  
  try {
    const result = await updatePowerByRegionByWeek({ startWeek, endWeek });
    console.log(`✅ Backfill complete! Updated ${result.updated} rows.`);
  } catch (error) {
    console.error("❌ Backfill failed:", error);
    process.exit(1);
  }
}

main();
