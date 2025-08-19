import { Elysia } from "elysia";
import {
  applications,
  requirementSets,
  wallets,
  walletWeeklyRewards,
  zones,
} from "../../db/schema";
import { db } from "../../db/db";
import { and, eq, not, or } from "drizzle-orm";
import { getProtocolWeek } from "../../utils/getProtocolWeek";
import { updateWalletRewardsForWeek } from "../../crons/update-wallet-rewards";
import { findAllPermissions } from "../../db/queries/permissions/findAllPermissions";
import { permissions } from "../../types/api-types/Permissions";
import { createPermission } from "../../db/mutations/permissions/createPermission";
import { downloadFile, uploadFile } from "../../utils/r2/upload-to-r2";
import { Documents } from "../../db/schema";
import convert from "heic-convert";
import fs from "fs";
import path from "path";
import { OpenAI } from "openai";
import { updateUser } from "../../db/mutations/users/updateUser";
import { updateInstaller } from "../../db/mutations/installers/updateInstaller";
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
  });
// .get("/migrate-applications-too-advanced-step", async ({ set }) => {
//   try {
//     await db.transaction(async (tx) => {
//       await tx
//         .update(applications)
//         .set({
//           status: ApplicationStatusEnum.waitingForApproval,
//         })
//         .where(
//           and(
//             eq(applications.currentStep, ApplicationSteps.payment),
//             or(
//               eq(applications.status, ApplicationStatusEnum.paymentConfirmed),
//               eq(applications.status, ApplicationStatusEnum.waitingForPayment)
//             )
//           )
//         );
//     });
//     return { message: "success" };
//   } catch (error) {
//     console.error("Error anonymizing users and installers", error);
//     return { message: "error" };
//   }
// });
// .get("/anonymize-users-and-installers", async ({ set }) => {
//   try {
//     await db.transaction(async (tx) => {
//       // Anonymize users
//       // const allUsers = await tx.query.users.findMany();
//       // for (const user of allUsers) {
//       //   await updateUser(
//       //     {
//       //       firstName: "Anon",
//       //       lastName: "User",
//       //       email: `anon+${user.id}@example.com`,
//       //       companyName: "Anon Corp",
//       //       companyAddress: "123 Anon St",
//       //     },
//       //     user.id
//       //   );
//       // }

//       // // Anonymize installers
//       // const allInstallers = await tx.query.installers.findMany();
//       // for (const installer of allInstallers) {
//       //   await updateInstaller(
//       //     {
//       //       name: "Anon Installer",
//       //       email: `anon+${installer.id}@example.com`,
//       //       companyName: "Anon Installers",
//       //       phone: "000-000-0000",
//       //     },
//       //     installer.id
//       //   );
//       // }

//       await tx
//         .update(applications)
//         .set({
//           userId: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
//         })
//         .where(not(eq(applications.status, ApplicationStatusEnum.completed)));
//     });
//     return { message: "success" };
//   } catch (error) {
//     console.error("Error anonymizing users and installers", error);
//     return { message: "error" };
//   }
// });
// .get("/identify-solar-panels-batch", async ({ set }) => {
//   try {
//     // Fetch all after-install pictures that are not HEIC
//     const afterInstallPictures = await db.query.Documents.findMany({
//       where: (doc, { and, like, notInArray }) =>
//         and(
//           like(doc.name, "%after_install_pictures%"),
//           notInArray(doc.type, ["heic", "HEIC"])
//         ),
//       with: {
//         application: {
//           columns: {
//             id: true,
//           },
//         },
//       },
//     });

//     if (afterInstallPictures.length === 0) {
//       set.status = 404;
//       return {
//         message: "No after-install pictures found",
//         total: 0,
//       };
//     }

//     console.log(
//       `Found ${afterInstallPictures.length} after-install pictures to process`
//     );

//     // Create batch requests for OpenAI
//     const batchRequests = afterInstallPictures.map((doc, index) => ({
//       custom_id: `${doc.applicationId}_${index}_${doc.id}`,
//       method: "POST" as const,
//       url: "/v1/chat/completions",
//       body: {
//         model: "gpt-4o-mini",
//         temperature: 0,
//         max_tokens: 10,
//         messages: [
//           {
//             role: "user",
//             content: [
//               {
//                 type: "text",
//                 text: 'Does this image clearly show one or more solar panels? Reply "yes" or "no" only.',
//               },
//               {
//                 type: "image_url",
//                 image_url: { url: doc.url },
//               },
//             ],
//           },
//         ],
//       },
//     }));

//     // Save batch requests to file
//     const requestsFile = `batch-requests-${Date.now()}.jsonl`;
//     const requestsContent = batchRequests
//       .map((r) => JSON.stringify(r))
//       .join("\n");

//     fs.writeFileSync(path.join(process.cwd(), requestsFile), requestsContent);
//     console.log(`📄 Saved requests to ${requestsFile}`);

//     // Create OpenAI client

//     const openai = new OpenAI({
//       apiKey: process.env.OPENAI_API_KEY,
//     });

//     // Upload file to OpenAI
//     console.log("📤 Uploading batch file...");
//     const file = await openai.files.create({
//       file: fs.createReadStream(path.join(process.cwd(), requestsFile)),
//       purpose: "batch",
//     });
//     console.log(`✅ File uploaded: ${file.id}`);

//     // Create batch
//     console.log("🔄 Creating batch...");
//     const batch = await openai.batches.create({
//       input_file_id: file.id,
//       endpoint: "/v1/chat/completions",
//       completion_window: "24h",
//       metadata: {
//         description: "Solar panel detection batch for after-install pictures",
//         total_images: batchRequests.length.toString(),
//       },
//     });

//     console.log(`✅ Batch created: ${batch.id}`);
//     console.log(`📋 Status: ${batch.status}`);

//     // Create image map for later reference
//     const imageMap = afterInstallPictures.reduce((acc, doc, index) => {
//       const customId = `${doc.applicationId}_${index}_${doc.id}`;
//       acc[customId] = {
//         documentId: doc.id,
//         applicationId: doc.applicationId,
//         url: doc.url,
//         name: doc.name,
//       };
//       return acc;
//     }, {} as Record<string, { documentId: string; applicationId: string; url: string; name: string }>);

//     // Save batch info for later retrieval
//     const batchInfo = {
//       batchId: batch.id,
//       fileId: file.id,
//       imageMap,
//       createdAt: new Date().toISOString(),
//       totalRequests: batchRequests.length,
//     };

//     fs.writeFileSync(
//       path.join(process.cwd(), `batch-info-${batch.id}.json`),
//       JSON.stringify(batchInfo, null, 2)
//     );
//     console.log(`💾 Batch info saved to batch-info-${batch.id}.json`);

//     // Clean up temporary file
//     fs.unlinkSync(path.join(process.cwd(), requestsFile));

//     set.status = 200;
//     return {
//       message: "Batch processing initiated successfully",
//       batchId: batch.id,
//       status: batch.status,
//       totalImages: afterInstallPictures.length,
//       estimatedCost: `~$${(afterInstallPictures.length * 0.00015).toFixed(
//         4
//       )} (with 50% batch discount)`,
//       nextSteps: [
//         "Wait for batch completion (up to 24 hours)",
//         `Check status at GET /admin/check-solar-panels-batch-status/${batch.id}`,
//         `Retrieve results at GET /admin/retrieve-solar-panels-batch-results/${batch.id}`,
//       ],
//     };
//   } catch (error) {
//     console.error("Error in solar panel batch processing:", error);
//     set.status = 500;
//     return {
//       message: "Error initiating batch processing",
//       error: error instanceof Error ? error.message : "Unknown error",
//     };
//   }
// })
// .get("/check-solar-panels-batch-status/:batchId", async ({ params, set }) => {
//   try {
//     const openai = new OpenAI({
//       apiKey: process.env.OPENAI_API_KEY,
//     });

//     const batch = await openai.batches.retrieve(params.batchId);

//     set.status = 200;
//     return {
//       batchId: batch.id,
//       status: batch.status,
//       createdAt: batch.created_at,
//       inProgressAt: batch.in_progress_at,
//       completedAt: batch.completed_at,
//       failedAt: batch.failed_at,
//       requestCounts: batch.request_counts,
//       metadata: batch.metadata,
//     };
//   } catch (error) {
//     console.error("Error checking batch status:", error);
//     set.status = 500;
//     return {
//       message: "Error checking batch status",
//       error: error instanceof Error ? error.message : "Unknown error",
//     };
//   }
// })
// .get(
//   "/retrieve-solar-panels-batch-results/:batchId",
//   async ({ params, set }) => {
//     try {
//       // Load batch info
//       const batchInfoPath = path.join(
//         process.cwd(),
//         `batch-info-${params.batchId}.json`
//       );
//       if (!fs.existsSync(batchInfoPath)) {
//         set.status = 404;
//         return { message: "Batch info not found" };
//       }

//       const batchInfo = JSON.parse(fs.readFileSync(batchInfoPath, "utf8"));

//       const openai = new OpenAI({
//         apiKey: process.env.OPENAI_API_KEY,
//       });

//       // Check batch status
//       const batch = await openai.batches.retrieve(params.batchId);

//       if (batch.status !== "completed") {
//         set.status = 202;
//         return {
//           message: `Batch is still ${batch.status}`,
//           status: batch.status,
//           requestCounts: batch.request_counts,
//         };
//       }

//       if (!batch.output_file_id) {
//         set.status = 404;
//         return { message: "Batch output file not found" };
//       }

//       // Retrieve the output file
//       const fileResponse = await openai.files.content(batch.output_file_id);
//       const fileContent = await fileResponse.text();

//       // Parse results
//       const results = fileContent
//         .split("\n")
//         .filter((line) => line.trim())
//         .map((line) => JSON.parse(line));

//       // Process results
//       const processedResults = results.map((result) => {
//         const imageInfo = batchInfo.imageMap[result.custom_id];
//         const hasSolarPanels =
//           result.response?.body?.choices?.[0]?.message?.content
//             ?.toLowerCase()
//             .includes("yes");

//         return {
//           documentId: imageInfo.documentId,
//           applicationId: imageInfo.applicationId,
//           documentName: imageInfo.name,
//           url: imageInfo.url,
//           hasSolarPanels,
//           response: result.response?.body?.choices?.[0]?.message?.content,
//         };
//       });

//       // Update documents in database for those showing solar panels
//       const documentsWithSolarPanels = processedResults.filter(
//         (r) => r.hasSolarPanels
//       );

//       if (documentsWithSolarPanels.length > 0) {
//         console.log(
//           `Updating ${documentsWithSolarPanels.length} documents with solar panels...`
//         );

//         // Update each document that has solar panels
//         await db.transaction(async (tx) => {
//           for (const doc of documentsWithSolarPanels) {
//             await tx
//               .update(Documents)
//               .set({
//                 isShowingSolarPanels: true,
//                 updatedAt: new Date(),
//               })
//               .where(eq(Documents.id, doc.documentId));
//           }
//         });

//         console.log(
//           `✅ Updated ${documentsWithSolarPanels.length} documents`
//         );
//       }

//       // Summary statistics
//       const summary = {
//         total: processedResults.length,
//         withSolarPanels: processedResults.filter((r) => r.hasSolarPanels)
//           .length,
//         withoutSolarPanels: processedResults.filter((r) => !r.hasSolarPanels)
//           .length,
//         databaseUpdated: documentsWithSolarPanels.length,
//       };

//       // Save results
//       const resultsPath = path.join(
//         process.cwd(),
//         `solar-panels-results-${params.batchId}.json`
//       );
//       fs.writeFileSync(
//         resultsPath,
//         JSON.stringify(
//           {
//             batchId: params.batchId,
//             processedAt: new Date().toISOString(),
//             summary,
//             results: processedResults,
//           },
//           null,
//           2
//         )
//       );

//       // Clean up batch info file
//       fs.unlinkSync(batchInfoPath);

//       set.status = 200;
//       return {
//         message: "Batch results retrieved and database updated successfully",
//         batchId: params.batchId,
//         summary,
//         resultsFile: `solar-panels-results-${params.batchId}.json`,
//         results: processedResults,
//       };
//     } catch (error) {
//       console.error("Error retrieving batch results:", error);
//       set.status = 500;
//       return {
//         message: "Error retrieving batch results",
//         error: error instanceof Error ? error.message : "Unknown error",
//       };
//     }
//   }
// );
// .get("/convert-heic-to-jpeg", async ({ set }) => {
//   try {
//     // Find all HEIC documents
//     const heicDocuments = await db.query.Documents.findMany({
//       where: (doc, { eq }) => eq(doc.type, "heic"),
//       with: {
//         application: {
//           columns: {
//             id: true,
//           },
//         },
//       },
//     });

//     if (heicDocuments.length === 0) {
//       return { message: "No HEIC documents found", converted: 0 };
//     }

//     console.log(`Found ${heicDocuments.length} HEIC documents to convert`);

//     let converted = 0;
//     const errors: Array<{ documentId: string; error: string }> = [];

//     for (const doc of heicDocuments) {
//       try {
//         console.log(`Converting document ${doc.id} - ${doc.name}`);

//         if (!doc.url.includes("heic")) {
//           // const extension = doc.url.split(".").pop();
//           // if (!extension) {
//           //   console.log(`Document ${doc.id} has no extension`);
//           //   continue;
//           // }
//           // if (extension !== "jpg" && extension !== "jpeg") {
//           //   console.log(
//           //     `Document ${doc.id} has invalid extension: ${extension}`
//           //   );
//           //   continue;
//           // }
//           // await db
//           //   .update(Documents)
//           //   .set({
//           //     type: extension,
//           //     updatedAt: new Date(),
//           //   })
//           //   .where(eq(Documents.id, doc.id));
//           // console.log(`Document ${doc.id} has been updated to ${extension}`);
//           continue;
//         }
//         const bucketId = doc.application.id;

//         console.log("Original URL:", doc.url);

//         // Determine the bucket based on the URL pattern
//         const bucketName = "gca-crm-public-prod";
//         const key = `${bucketId}/${doc.name}.heic`;
//         // Download the HEIC file
//         console.log(`Downloading from bucket: ${bucketName}, key: ${key}`);
//         const heicBuffer = await downloadFile(bucketName, key);

//         // Convert HEIC to jpeg
//         console.log(`Converting HEIC to jpeg...`);
//         const jpegBuffer = await convert({
//           buffer: heicBuffer,
//           format: "JPEG",
//           quality: 0.9, // High quality
//         });

//         // Create new key for jpeg file (replace .heic with .jpeg)
//         const newKey = `${bucketId}/${doc.name}-converted.jpeg`;

//         // Upload the jpeg file to the same bucket
//         console.log(
//           `Uploading jpeg to bucket: ${bucketName}, key: ${newKey}`
//         );

//         await uploadFile(bucketName, newKey, jpegBuffer, "image/jpeg");
//         const newUrl = `https://pub-e71c2d06062242109db2bdd6b0bb5ee0.r2.dev/${newKey}`;
//         const newDocument = {
//           name: `${doc.name}-converted`,
//           applicationId: doc.application.id,
//           createdAt: doc.createdAt,
//           step: doc.step,
//           url: newUrl,
//           type: "jpeg",
//           updatedAt: new Date(),
//         };
//         const newDocumentId = await db
//           .insert(Documents)
//           .values(newDocument)
//           .returning({ id: Documents.id });
//         console.log("newDocumentId", newDocumentId);

//         console.log(`Successfully converted document ${doc.id}`);
//         converted++;
//       } catch (error) {
//         console.error(`Error converting document ${doc.id}:`, error);
//         errors.push({
//           documentId: doc.id,
//           error: error instanceof Error ? error.message : "Unknown error",
//         });
//       }
//     }

//     set.status = 200;
//     return {
//       message: `Conversion completed. Converted ${converted} out of ${heicDocuments.length} documents.`,
//       total: heicDocuments.length,
//       converted,
//       failed: errors.length,
//       errors: errors.length > 0 ? errors : undefined,
//     };
//   } catch (error) {
//     console.error("Error in HEIC conversion process:", error);
//     set.status = 500;
//     return {
//       message: "Error converting HEIC images",
//       error: error instanceof Error ? error.message : "Unknown error",
//     };
//   }
// });
// .get("/migrate-legacy-applications", async ({ set }) => {
//   try {
//     await db.transaction(async (tx) => {
//       /* 1️⃣  Resolve the Clean-Grid zone id (fail-fast if missing) */
//       const cleanGridZone = await tx.query.zones.findFirst({
//         where: (z, { eq }) => eq(z.id, 1),
//       });
//       if (!cleanGridZone) throw new Error("Clean-Grid zone not bootstrapped");

//       /* 2️⃣  Load every legacy application (idempotent re-run is OK) */
//       const legacyApps = await tx.select().from(applications);

//       if (legacyApps.length === 0) return; // nothing to do

//       /* 3️⃣  Prepare rows for each target table ----------------------- */
//       const enquiryRows: (typeof applicationsEnquiryFieldsCRS.$inferInsert)[] =
//         [];
//       const auditRows: (typeof applicationsAuditFieldsCRS.$inferInsert)[] =
//         [];

//       for (const a of legacyApps) {
//         enquiryRows.push({
//           applicationId: a.id,
//           address: a.address,
//           farmOwnerName: a.farmOwnerName,
//           farmOwnerEmail: a.farmOwnerEmail,
//           farmOwnerPhone: a.farmOwnerPhone,
//           lat: a.lat,
//           lng: a.lng,
//           estimatedCostOfPowerPerKWh: a.estimatedCostOfPowerPerKWh,
//           estimatedKWhGeneratedPerYear: a.estimatedKWhGeneratedPerYear,
//           enquiryEstimatedFees: a.enquiryEstimatedFees,
//           enquiryEstimatedQuotePerWatt: a.enquiryEstimatedQuotePerWatt,
//           installerName: a.installerName!,
//           installerCompanyName: a.installerCompanyName!,
//           installerEmail: a.installerEmail!,
//           installerPhone: a.installerPhone!,
//         });

//         if (
//           a.status === ApplicationStatusEnum.completed &&
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

//       console.log("auditRows", auditRows);
//       await tx
//         .insert(applicationsAuditFieldsCRS)
//         .values(auditRows)
//         .onConflictDoNothing();

//       // /* 5️⃣  Patch every farm that still has the legacy zone (1) */
//       // await tx
//       //   .update(farms)
//       //   .set({ zoneId: cleanGridZoneId })
//       //   .where(eq(farms.zoneId, 1));
//     });

//     set.status = 200;
//     return { message: "Legacy applications migrated to v2 schema 🎉" };
//   } catch (err) {
//     console.error("migration-error", err);
//     set.status = 500;
//     return { message: "Migration failed" };
//   }
// });
