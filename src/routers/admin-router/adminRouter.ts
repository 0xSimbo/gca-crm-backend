import { Elysia, t } from "elysia";
import {
  applications,
  applicationsAuditFieldsCRS,
  applicationsEnquiryFieldsCRS,
  farms,
  requirementSets,
  wallets,
  walletWeeklyRewards,
  zones,
} from "../../db/schema";
import { z } from "zod/v4";
import { db } from "../../db/db";
import { and, eq } from "drizzle-orm";
import { getProtocolWeek } from "../../utils/getProtocolWeek";
import { updateWalletRewardsForWeek } from "../../crons/update-wallet-rewards";
import { findAllPermissions } from "../../db/queries/permissions/findAllPermissions";
import { permissions } from "../../types/api-types/Permissions";
import { createPermission } from "../../db/mutations/permissions/createPermission";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";

export const adminRouter = new Elysia({ prefix: "/admin" })
  .get("/update-rewards-for-all-weeks", async () => {
    return { message: "dev only" };
    const lastWeek = getProtocolWeek() - 1;
    try {
      // await db.update(farms).set({
      //   totalUSDGRewards: BigInt(0),
      //   totalGlowRewards: BigInt(0),
      // });
      await db.update(wallets).set({
        totalUSDGRewards: BigInt(0),
        totalGlowRewards: BigInt(0),
      });
      // await db.delete(farmRewards);
      // await db.delete(deviceRewards);
      await db.delete(walletWeeklyRewards);
      // const deviceLifetimeMetrics = await getDevicesLifetimeMetrics();
      for (let i = 10; i <= lastWeek; i++) {
        console.log("Updating rewards for week", i);
        await updateWalletRewardsForWeek(i);
        // await updateDeviceRewardsForWeek({
        //   deviceLifetimeMetrics,
        //   weekNumber: i,
        // });
        // await updateFarmRewardsForWeek({
        //   deviceLifetimeMetrics,
        //   weekNumber: i,
        // });
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error updating rewards", error);
      return { message: "error" };
    }
  })
  .get("/migrate-farms", async () => {
    // const farmsData: MigrationFarmData[] = LegacyFarmsData.map((farm) => ({
    //   ...farm,
    //   old_short_ids: (farm.old_short_ids || []).map((shortId) =>
    //     shortId.toString()
    //   ),
    // }));

    // try {
    //   for (const farmData of farmsData) {
    //     await insertFarmWithDependencies(farmData);
    //   }
    //   return { message: "success" };
    // } catch (error) {
    //   console.error("Error migrating farm", error);
    //   return { message: "error" };
    // }

    try {
      // console.log("Migrating farms coordinates");
      //   // hub farms
      //   const farmsData = await findAllFarmsCoordinates();
      //   // legacy farms
      //   // const farmsData = await findAllLegacyFarmsCoordinates();

      //   for (const farm of farmsData) {
      //     if (!farm.farmId) {
      //       console.log("No farm id found for farm", farm);
      //       continue;
      //     }
      //     if (
      //       farm.region !== "__UNSET__" &&
      //       farm.regionFullName !== "__UNSET__" &&
      //       farm.signalType !== "__UNSET__"
      //     ) {
      //       // console.log("Farm already has region", farm);
      //       continue;
      //     }
      //     const region = await getRegionFromLatAndLng(farm.lat, farm.lng);
      //     await updateFarmRegion(farm.farmId, region);
      //   }

      return { message: "success" };
    } catch (error) {
      console.error("Error migrating farm", error);
      return { message: "error" };
    }
  })
  .get("/seed-permissions", async () => {
    try {
      const dbPermissions = await findAllPermissions();
      if (dbPermissions.length > 0) {
        throw new Error("Permissions already seeded");
      }
      for (const permission of permissions) {
        await createPermission(permission);
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error seeding permissions", error);
      if (error instanceof Error) {
        return { message: error.message };
      }
      return { message: "error" };
    }
  })
  .get("/bootstrap-clean-grid-zone", async ({ set }) => {
    try {
      await db.transaction(async (tx) => {
        const requirementSetId = 1;
        // 1. Create the requirement set
        await tx
          .insert(requirementSets)
          .values({
            id: requirementSetId,
            code: "CRS",
            name: "Competitive Recursive Subsidy",
          })
          .returning();

        // 2. Create the zone
        await tx
          .insert(zones)
          .values({
            id: 1,
            name: "Clean Grid Project",
            requirementSetId,
          })
          .returning();
      });
      set.status = 201;
      return { message: "Zone and steps with JSON Schemas created" };
    } catch (error) {
      console.error("Error bootstrapping clean grid zone", error);
      return { message: "error" };
    }
  }); // GET /migrate-legacy-applications
// .get("/migrate-legacy-applications", async ({ set }) => {
//   try {
//     await db.transaction(async (tx) => {
//       /* 1️⃣  Resolve the Clean-Grid zone id (fail-fast if missing) */
//       const cleanGridZone = await tx.query.zones.findFirst({
//         where: (z, { eq }) => eq(z.id, 1),
//       });
//       if (!cleanGridZone) throw new Error("Clean-Grid zone not bootstrapped");
//       const cleanGridZoneId = cleanGridZone.id;

//       /* 2️⃣  Load every legacy application (idempotent re-run is OK) */
//       const legacyApps = await tx.select().from(applications);

//       if (legacyApps.length === 0) return; // nothing to do

//       /* 3️⃣  Prepare rows for each target table ----------------------- */
//       const commonRows: ApplicationCommonInsert[] = [];
//       const enquiryRows: (typeof applicationsEnquiryFieldsCRS.$inferInsert)[] =
//         [];
//       const auditRows: (typeof applicationsAuditFieldsCRS.$inferInsert)[] =
//         [];

//       for (const a of legacyApps) {
//         if (a.currentStep > ApplicationSteps.enquiry) {
//           enquiryRows.push({
//             applicationId: a.id,
//             address: a.address,
//             farmOwnerName: a.farmOwnerName,
//             farmOwnerEmail: a.farmOwnerEmail,
//             farmOwnerPhone: a.farmOwnerPhone,
//             lat: a.lat,
//             lng: a.lng,
//             estimatedCostOfPowerPerKWh: a.estimatedCostOfPowerPerKWh,
//             estimatedKWhGeneratedPerYear: a.estimatedKWhGeneratedPerYear,
//             enquiryEstimatedFees: a.enquiryEstimatedFees,
//             enquiryEstimatedQuotePerWatt: a.enquiryEstimatedQuotePerWatt,
//             installerName: a.installerName!,
//             installerCompanyName: a.installerCompanyName!,
//             installerEmail: a.installerEmail!,
//             installerPhone: a.installerPhone!,
//           });
//         }
//         if (
//           a.status > ApplicationStatusEnum.completed &&
//           a.currentStep === ApplicationSteps.payment
//         ) {
//           auditRows.push({
//             applicationId: a.id,
//             solarPanelsQuantity: a.solarPanelsQuantity!,
//             solarPanelsBrandAndModel: a.solarPanelsBrandAndModel!,
//             solarPanelsWarranty: a.solarPanelsWarranty!,
//             averageSunlightHoursPerDay: a.averageSunlightHoursPerDay!,
//             adjustedWeeklyCarbonCredits: a.adjustedWeeklyCarbonCredits!,
//             weeklyTotalCarbonDebt: a.weeklyTotalCarbonDebt!,
//             netCarbonCreditEarningWeekly: a.netCarbonCreditEarningWeekly!,
//             finalEnergyCost: a.finalEnergyCost!,
//             systemWattageOutput: a.systemWattageOutput!,
//             ptoObtainedDate: a.ptoObtainedDate!,
//             locationWithoutPII: a.locationWithoutPII!,
//             revisedInstallFinishedDate: a.revisedInstallFinishedDate!,
//           });
//         }
//       }

//       /* 4️⃣  Bulk-insert with ON-CONFLICT-DO-NOTHING (keeps idempotent) */
//       await tx
//         .insert(applicationsEnquiryFieldsCRS)
//         .values(enquiryRows)
//         .onConflictDoNothing();

//       await tx
//         .insert(applicationsAuditFieldsCRS)
//         .values(auditRows)
//         .onConflictDoNothing();

//       /* 5️⃣  Patch every farm that still has the legacy zone (1) */
//       await tx
//         .update(farms)
//         .set({ zoneId: cleanGridZoneId })
//         .where(eq(farms.zoneId, 1));
//     });

//     set.status = 200;
//     return { message: "Legacy applications migrated to v2 schema 🎉" };
//   } catch (err) {
//     console.error("migration-error", err);
//     set.status = 500;
//     return { message: "Migration failed" };
//   }
// });
