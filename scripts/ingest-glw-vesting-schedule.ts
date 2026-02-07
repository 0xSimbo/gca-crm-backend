import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db/db";
import { glwVestingSchedule } from "../src/db/schema";
import { parseVestingScheduleCsv } from "../src/pol/vesting/parseVestingCsv";

async function main() {
  const csvPath =
    process.argv[2] ?? path.join(process.cwd(), "data", "vesting_schedule.csv");
  const csv = fs.readFileSync(csvPath, "utf8");
  const rows = parseVestingScheduleCsv(csv);
  if (rows.length === 0) {
    console.log("No rows found in CSV.");
    process.exit(0);
  }

  let upserted = 0;
  for (const row of rows) {
    await db
      .insert(glwVestingSchedule)
      .values({
        date: row.date,
        unlocked: row.unlocked,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: glwVestingSchedule.date,
        set: {
          unlocked: row.unlocked,
          updatedAt: new Date(),
        },
      });
    upserted++;
  }

  console.log(`Ingested glw_vesting_schedule: ${upserted} rows (upsert).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to ingest glw_vesting_schedule:", err);
    process.exit(1);
  });

