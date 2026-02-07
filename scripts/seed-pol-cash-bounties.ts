import { db } from "../src/db/db";
import { polCashBounties } from "../src/db/schema";
import { CASH_BOUNTY_BY_APPLICATION_ID } from "../src/pol/bounties/cashBountySeed";

async function main() {
  const entries = Object.entries(CASH_BOUNTY_BY_APPLICATION_ID);
  if (entries.length === 0) {
    console.log("No entries to seed.");
    process.exit(0);
  }

  let upserted = 0;
  for (const [applicationId, bounty] of entries) {
    await db
      .insert(polCashBounties)
      .values({
        applicationId,
        bountyUsd: bounty === null ? null : bounty.toFixed(2),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: polCashBounties.applicationId,
        set: {
          bountyUsd: bounty === null ? null : bounty.toFixed(2),
          updatedAt: new Date(),
        },
      });
    upserted++;
  }

  console.log(`Seeded pol_cash_bounties: ${upserted} rows (upsert).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to seed pol_cash_bounties:", err);
    process.exit(1);
  });

