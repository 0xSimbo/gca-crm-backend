/**
 * Move Applications to Zone Script
 *
 * Moves specified applications to a target zone.
 *
 * Usage:
 *   # Dry run (default) - shows what would change without modifying the database
 *   bun run scripts/move-applications-to-zone.ts
 *
 *   # Execute for real
 *   bun run scripts/move-applications-to-zone.ts --execute
 */

import { db } from "../src/db/db";
import { applications, farms, zones } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";

// ============================================
// Configuration
// ============================================

const TARGET_ZONE_ID = 8; // Oklahoma

const APPLICATION_IDS = [
  "3c8a504d-64e1-4dca-b747-34fd438fa339",
  "52069f39-ff18-43b1-acbf-1c42e0a3fcd6",
  "b4ee929b-1eda-45f7-9dc9-7ccce1cd3347",
  "e393efea-32d7-4b38-8e7c-01be95d15857",
  "30ea67a3-8706-44ce-9c44-54595a909f30",
  "9a00e7f0-9a53-46ee-8271-8aa9f68eb425",
];

// ============================================
// Main Script
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = !args.includes("--execute");

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 Move Applications to Zone Script");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Mode: ${isDryRun ? "🔍 DRY RUN (no changes will be made)" : "⚡ EXECUTE MODE"}`);
  console.log(`Target Zone ID: ${TARGET_ZONE_ID}`);
  console.log(`Applications to move: ${APPLICATION_IDS.length}`);
  console.log("");

  // 1. Verify target zone exists
  console.log("1️⃣  Verifying target zone...");
  const targetZone = await db.query.zones.findFirst({
    where: eq(zones.id, TARGET_ZONE_ID),
  });

  if (!targetZone) {
    console.error(`❌ Zone ${TARGET_ZONE_ID} not found!`);
    process.exit(1);
  }

  console.log(`   ✅ Zone found: ${targetZone.name} (ID: ${targetZone.id})`);
  console.log(`   Active: ${targetZone.isActive ? "Yes" : "No"}`);
  console.log(`   Accepting Sponsors: ${targetZone.isAcceptingSponsors ? "Yes" : "No"}`);
  console.log("");

  // 2. Fetch all applications
  console.log("2️⃣  Fetching applications...");
  const appsToMove = await db.query.applications.findMany({
    where: inArray(applications.id, APPLICATION_IDS),
    columns: {
      id: true,
      zoneId: true,
      status: true,
      farmId: true,
      userId: true,
      createdAt: true,
    },
    with: {
      zone: {
        columns: {
          id: true,
          name: true,
        },
      },
      enquiryFieldsCRS: {
        columns: {
          address: true,
          farmOwnerName: true,
        },
      },
    },
  });

  // Check for missing applications
  const foundIds = appsToMove.map((a) => a.id);
  const missingIds = APPLICATION_IDS.filter((id) => !foundIds.includes(id));

  if (missingIds.length > 0) {
    console.warn(`   ⚠️  Missing applications (${missingIds.length}):`);
    missingIds.forEach((id) => console.warn(`      - ${id}`));
  }

  console.log(`   Found ${appsToMove.length}/${APPLICATION_IDS.length} applications`);
  console.log("");

  // 3. Display current state
  console.log("3️⃣  Current application state:");
  console.log("─────────────────────────────────────────────────────────────────────────────────────────────────────");
  console.log(
    "Application ID                           | Current Zone       | Status              | Has Farm | Owner"
  );
  console.log("─────────────────────────────────────────────────────────────────────────────────────────────────────");

  for (const app of appsToMove) {
    const currentZoneName = app.zone?.name || "Unknown";
    const ownerName = app.enquiryFieldsCRS?.farmOwnerName || app.userId?.slice(0, 10) + "...";
    const hasFarm = app.farmId ? "Yes" : "No";
    const zoneChange = app.zoneId === TARGET_ZONE_ID ? "(no change)" : `→ ${targetZone.name}`;

    console.log(
      `${app.id} | ${currentZoneName.padEnd(18)} | ${app.status.padEnd(19)} | ${hasFarm.padEnd(8)} | ${ownerName}`
    );
    if (app.zoneId !== TARGET_ZONE_ID) {
      console.log(`                                         | ${zoneChange}`);
    }
  }
  console.log("─────────────────────────────────────────────────────────────────────────────────────────────────────");
  console.log("");

  // 4. Filter applications that actually need updating
  const appsNeedingUpdate = appsToMove.filter((app) => app.zoneId !== TARGET_ZONE_ID);
  const appsAlreadyInZone = appsToMove.filter((app) => app.zoneId === TARGET_ZONE_ID);

  if (appsAlreadyInZone.length > 0) {
    console.log(`   ℹ️  ${appsAlreadyInZone.length} application(s) already in zone ${TARGET_ZONE_ID}`);
  }

  if (appsNeedingUpdate.length === 0) {
    console.log("   ✅ No applications need updating!");
    process.exit(0);
  }

  console.log(`   📝 ${appsNeedingUpdate.length} application(s) will be updated`);
  console.log("");

  // 5. Execute or show dry run summary
  if (isDryRun) {
    console.log("4️⃣  DRY RUN Summary:");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   Would update ${appsNeedingUpdate.length} application(s):`);
    for (const app of appsNeedingUpdate) {
      console.log(`   - ${app.id}: zone ${app.zoneId} → ${TARGET_ZONE_ID}`);
    }

    // Check if any apps have associated farms that also need updating
    const appsWithFarms = appsNeedingUpdate.filter((app) => app.farmId);
    if (appsWithFarms.length > 0) {
      console.log("");
      console.log(`   Would also update ${appsWithFarms.length} associated farm(s):`);
      for (const app of appsWithFarms) {
        console.log(`   - Farm ${app.farmId} (for application ${app.id})`);
      }
    }

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔍 This was a DRY RUN. No changes were made.");
    console.log("   Run with --execute to apply changes:");
    console.log("   bun run scripts/move-applications-to-zone.ts --execute");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  } else {
    console.log("4️⃣  Executing updates...");

    await db.transaction(async (tx) => {
      // Update applications
      const appIdsToUpdate = appsNeedingUpdate.map((app) => app.id);
      const appUpdateResult = await tx
        .update(applications)
        .set({ zoneId: TARGET_ZONE_ID, updatedAt: new Date() })
        .where(inArray(applications.id, appIdsToUpdate));

      console.log(`   ✅ Updated ${appsNeedingUpdate.length} application(s)`);

      // Update associated farms
      const farmIdsToUpdate = appsNeedingUpdate
        .filter((app) => app.farmId)
        .map((app) => app.farmId!);

      if (farmIdsToUpdate.length > 0) {
        await tx
          .update(farms)
          .set({ zoneId: TARGET_ZONE_ID })
          .where(inArray(farms.id, farmIdsToUpdate));

        console.log(`   ✅ Updated ${farmIdsToUpdate.length} associated farm(s)`);
      }
    });

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ All updates completed successfully!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
