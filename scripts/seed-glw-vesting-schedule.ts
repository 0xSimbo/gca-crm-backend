import "dotenv/config";

import { db } from "../src/db/db";
import { glwVestingSchedule } from "../src/db/schema";
import {
  getGlwVestingScheduleFromTokenSupply,
  type GlwVestingRules,
} from "../src/pol/vesting/tokenSupplyVestingSchedule";

function getDbHost(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function main() {
  const rules: GlwVestingRules = {
    contractUpgradeDateIso:
      process.env.GLW_CONTRACT_UPGRADE_DATE_ISO ?? "2026-02-07",
    investorUnlockEndIso: process.env.GLW_INVESTOR_UNLOCK_END_ISO ?? "2029-12-19",
    endTotalTokens: BigInt(process.env.GLW_END_TOTAL_TOKENS ?? "180000000"),
  };

  const schedule = getGlwVestingScheduleFromTokenSupply(rules);
  if (schedule.length === 0) {
    console.log("No vesting rows to seed.");
    return;
  }

  const host = getDbHost();
  console.log("Seeding glw_vesting_schedule", {
    dbHost: host ?? "unknown",
    rules: {
      contractUpgradeDateIso: rules.contractUpgradeDateIso,
      investorUnlockEndIso: rules.investorUnlockEndIso,
      endTotalTokens: rules.endTotalTokens.toString(),
    },
    rows: schedule.length,
    first: schedule[0],
    last: schedule[schedule.length - 1],
  });

  await db.transaction(async (tx) => {
    // Replace deterministically.
    await tx.delete(glwVestingSchedule);
    await tx.insert(glwVestingSchedule).values(
      schedule.map((r) => ({
        date: r.date,
        unlocked: r.unlocked,
        updatedAt: new Date(),
      }))
    );
  });

  console.log(`Seeded glw_vesting_schedule: ${schedule.length} rows`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to seed glw_vesting_schedule:", err);
    process.exit(1);
  });

