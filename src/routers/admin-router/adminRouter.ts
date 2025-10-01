import { Elysia, t } from "elysia";
import {
  applications,
  deviceRewards,
  farmRewards,
  wallets,
  walletWeeklyRewards,
} from "../../db/schema";
import { db } from "../../db/db";
import postgres from "postgres";
import { PG_DATABASE_URL, PG_ENV } from "../../db/PG_ENV";
import { getProtocolWeek, getCurrentEpoch } from "../../utils/getProtocolWeek";
import { updateWalletRewardsForWeek } from "../../crons/update-wallet-rewards";
import { findAllPermissions } from "../../db/queries/permissions/findAllPermissions";
import { permissions } from "../../types/api-types/Permissions";
import { createPermission } from "../../db/mutations/permissions/createPermission";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";
import { farms } from "../../db/schema";
import { getProtocolFeePaymentFromTxHashReceipt } from "../../utils/getProtocolFeePaymentFromTxHashReceipt";
import { getDevicesLifetimeMetrics } from "../../crons/update-farm-rewards/get-devices-lifetime-metrics";
import { updateDeviceRewardsForWeek } from "../../crons/update-farm-rewards/update-device-rewards-for-week";
import { updateFarmRewardsForWeek } from "../../crons/update-farm-rewards/update-farm-rewards-for-week";
import { manualRetryFailedOperation } from "../../services/retryFailedOperations";
import { isNull, eq, not, or } from "drizzle-orm";

export const adminRouter = new Elysia({ prefix: "/admin" })
  .get("/update-rewards-for-all-weeks", async () => {
    return { message: "dev only" };
    const lastWeek = getProtocolWeek() - 1;
    try {
      await db.update(farms).set({
        totalUSDGRewards: BigInt(0),
        totalGlowRewards: BigInt(0),
      });
      await db.update(wallets).set({
        totalUSDGRewards: BigInt(0),
        totalGlowRewards: BigInt(0),
      });
      await db.delete(farmRewards);
      await db.delete(deviceRewards);
      await db.delete(walletWeeklyRewards);
      const deviceLifetimeMetrics = await getDevicesLifetimeMetrics();
      for (let i = 10; i <= lastWeek; i++) {
        console.log("Updating rewards for week", i);
        await updateWalletRewardsForWeek(i);
        await updateDeviceRewardsForWeek({
          deviceLifetimeMetrics,
          weekNumber: i,
        });
        await updateFarmRewardsForWeek({
          deviceLifetimeMetrics,
          weekNumber: i,
        });
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error updating rewards", error);
      return { message: "error" };
    }
  })
  .get("/migrate-farms", async () => {
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
  .get(
    "/fix-zones-sequence",
    async ({ set }) => {
      try {
        if (process.env.NODE_ENV === "production") {
          set.status = 404;
          return { message: "Not allowed in production" };
        }

        console.log("Checking zones table and sequence...");

        // Create postgres client for raw queries
        const sqlClient = postgres(PG_DATABASE_URL, PG_ENV);

        try {
          // Get the maximum ID from the zones table
          const maxIdResult =
            await sqlClient`SELECT MAX(zone_id) as max_id FROM zones`;
          const maxId = maxIdResult[0]?.max_id || 0;
          console.log(`Maximum zone_id in table: ${maxId}`);

          // Get the current sequence value
          const seqResult =
            await sqlClient`SELECT last_value FROM zones_zone_id_seq`;
          const currentSeqValue = seqResult[0]?.last_value;
          console.log(`Current sequence value: ${currentSeqValue}`);

          if (maxId >= currentSeqValue) {
            const newSeqValue = maxId + 1;
            console.log(`Updating sequence to: ${newSeqValue}`);

            // Reset the sequence to the correct value
            await sqlClient`SELECT setval('zones_zone_id_seq', ${newSeqValue}, false)`;

            // Verify the fix
            const verifyResult =
              await sqlClient`SELECT last_value FROM zones_zone_id_seq`;
            const newSequenceValue = verifyResult[0]?.last_value;

            return {
              message: "Zones sequence fixed successfully",
              previousMaxId: maxId,
              previousSequenceValue: currentSeqValue,
              newSequenceValue: newSequenceValue,
              updated: true,
            };
          } else {
            return {
              message: "Zones sequence is already at the correct value",
              maxId: maxId,
              currentSequenceValue: currentSeqValue,
              updated: false,
            };
          }
        } finally {
          await sqlClient.end();
        }
      } catch (error) {
        console.error("Error fixing zones sequence", error);
        set.status = 500;
        return {
          message: "Error fixing zones sequence",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      detail: {
        summary: "Fix zones table sequence",
        description:
          "Fixes the PostgreSQL sequence for the zones table primary key when it gets out of sync. This resolves 'duplicate key value violates unique constraint zones_pkey' errors.",
        tags: ["admin", "maintenance"],
      },
    }
  )
  .get(
    "/retry-failed-operation/:operationId",
    async ({ params, set }) => {
      try {
        const operationId = parseInt(params.operationId);

        if (isNaN(operationId)) {
          set.status = 400;
          return {
            message: "Invalid operation ID",
            error: "Operation ID must be a number",
          };
        }

        console.log(
          `[adminRouter] Manual retry requested for operation ${operationId}`
        );

        const result = await manualRetryFailedOperation(operationId);

        set.status = result.success ? 200 : 500;

        return {
          message: result.success
            ? `Successfully retried operation ${operationId}`
            : `Failed to retry operation ${operationId}`,
          result,
        };
      } catch (error) {
        console.error("Error in manual retry:", error);
        set.status = 500;

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // Special handling for specific error cases
        if (errorMessage.includes("not found")) {
          set.status = 404;
        } else if (errorMessage.includes("already resolved")) {
          set.status = 400;
        }

        return {
          message: "Error retrying failed operation",
          error: errorMessage,
        };
      }
    },
    {
      detail: {
        summary: "Manually retry a failed fraction operation",
        description:
          "Manually retries a specific failed fraction operation by its ID. " +
          "This is useful when automatic retries have failed and manual intervention is required. " +
          "Note: Operations are only automatically retried once before requiring manual retry.",
        tags: ["admin", "fractions", "maintenance"],
        query: t.Object({
          operationId: t.String(),
        }),
      },
    }
  )
  .get(
    "/farms-data-export",
    async ({ set }) => {
      try {
        console.log("Fetching farms data for export...");

        // Get all farms with their associated data
        const farmsData = await db.query.farms.findMany({
          with: {
            rewardSplits: true,
            devices: true,
          },
        });

        // Get all applications with completed status
        const allApplications = await db.query.applications.findMany({
          where: (app, { and, eq, isNotNull }) =>
            and(
              isNotNull(app.farmId),
              eq(app.status, ApplicationStatusEnum.completed),
              eq(app.currentStep, ApplicationSteps.payment)
            ),
        });

        // Get all audit fields
        const allAuditFields =
          await db.query.applicationsAuditFieldsCRS.findMany();

        // Fetch device lifetime metrics from API
        console.log("Fetching device lifetime metrics...");
        let deviceMetrics: any[] = [];
        try {
          const response = await fetch(
            "https://glow-green-api.simonnfts.workers.dev/devices-lifetime-metrics"
          );
          const data = await response.json();
          if (data.res?.success && Array.isArray(data.res.data)) {
            deviceMetrics = data.res.data;
          }
        } catch (error) {
          console.error("Error fetching device metrics:", error);
        }

        const farms: Record<string, any> = {};
        const protocolDeposits: Array<any> = [];

        // Process each farm
        for (const farm of farmsData) {
          // Find the application for this farm
          const app = allApplications.find((a) => a.farmId === farm.id);
          if (!app) {
            console.log(`No completed application found for farm ${farm.id}`);
            continue;
          }

          const auditFields = allAuditFields.find(
            (af) => af.applicationId === app.id
          );
          if (!auditFields) {
            console.log(`No audit fields found for farm ${farm.id}`);
            continue;
          }

          // Get net weekly carbon credits and multiply by 1e6
          const netWeeklyCarbonCredits = parseFloat(
            auditFields.netCarbonCreditEarningWeekly || "0"
          );
          const netWeeklyCarbonCredits6Decimals = netWeeklyCarbonCredits;

          // Validate reward splits sum to 100%
          let glowSplitSum = 0;
          let usdgSplitSum = 0;

          for (const split of farm.rewardSplits) {
            glowSplitSum += parseFloat(split.glowSplitPercent);
            usdgSplitSum += parseFloat(split.usdgSplitPercent);
          }

          // Check if splits sum to 100 (with small tolerance for floating point errors)
          const tolerance = 0;
          if (Math.abs(glowSplitSum - 100) > tolerance) {
            console.error(
              `Farm ${farm.id}: Glow splits sum to ${glowSplitSum}% instead of 100%`
            );
            continue;
          }

          if (Math.abs(usdgSplitSum - 100) > tolerance) {
            console.error(
              `Farm ${farm.id}: USDG splits sum to ${usdgSplitSum}% instead of 100%`
            );
            continue;
          }

          // Format reward splits (multiply by 1e4 to get 6 decimals from percentage with 2 decimals)
          const rewardsSplits = farm.rewardSplits.map((split) => ({
            walletAddress: split.walletAddress,
            glowSplitPercent6Decimals: BigInt(
              parseFloat(split.glowSplitPercent) * 1e4
            ).toString(),
            depositSplitPercent6Decimals: BigInt(
              parseFloat(split.usdgSplitPercent) * 1e4
            ).toString(),
          }));

          // Find first protocol week for this farm based on its devices
          let firstProtocolWeek: number | null = null;

          if (farm.devices && farm.devices.length > 0) {
            const farmDeviceWeeks: number[] = [];

            for (const device of farm.devices) {
              // Find matching device metrics by publicKey or shortId
              const deviceMetric = deviceMetrics.find(
                (dm) =>
                  dm.hexlifiedPublicKey === device.publicKey ||
                  dm.shortId === Number(device.shortId)
              );

              if (
                deviceMetric &&
                deviceMetric.weeklyData &&
                deviceMetric.weeklyData.length > 0
              ) {
                // Get all week numbers for this device
                const weekNumbers = deviceMetric.weeklyData.map(
                  (wd: any) => wd.weekNumber
                );
                farmDeviceWeeks.push(...weekNumbers);
              }
            }

            // Find the minimum week number across all devices
            if (farmDeviceWeeks.length > 0) {
              firstProtocolWeek = Math.min(...farmDeviceWeeks);
            }
          }

          farms[farm.id] = {
            net_weekly_carbon_credits: netWeeklyCarbonCredits6Decimals,
            rewards_splits: rewardsSplits,
            first_reward_week: firstProtocolWeek,
          };

          // Process protocol deposits
          const paymentTxHashes = [
            app.paymentTxHash,
            app.additionalPaymentTxHash,
          ].filter(Boolean);

          for (const txHash of paymentTxHashes) {
            if (!txHash) continue;

            try {
              const paymentInfo = await getProtocolFeePaymentFromTxHashReceipt(
                txHash
              );

              const paymentTimestamp = paymentInfo.paymentDate.getTime() / 1000;
              const weekProvided = getCurrentEpoch(paymentTimestamp);

              protocolDeposits.push({
                corresponding_farm: farm.id,
                usdg_provided: paymentInfo.amount,
                week_provided: weekProvided,
              });
            } catch (error) {
              console.error(
                `Error processing payment tx ${txHash} for farm ${farm.id}:`,
                error
              );
            }
          }
        }

        set.status = 200;
        return {
          farms,
          protocol_deposits: protocolDeposits,
        };
      } catch (error) {
        console.error("Error fetching farms data export:", error);
        set.status = 500;
        return {
          message: "Error fetching farms data",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      detail: {
        summary: "Export farms data with protocol deposits",
        description:
          "Returns all farms with their net weekly carbon credits, reward splits, " +
          "and protocol deposits including the week each deposit was made.",
        tags: ["admin", "farms", "export"],
      },
    }
  )
  .get(
    "/patch-gca-address",
    async ({ set }) => {
      try {
        if (process.env.NODE_ENV === "production") {
          set.status = 404;
          return { message: "Not allowed in production" };
        }

        const targetGcaAddress = "0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd";

        console.log(
          `Updating all applications to use GCA address: ${targetGcaAddress}`
        );

        // Find all applications that don't have the target GCA address
        const applicationsToUpdate = await db.query.applications.findMany({
          where: (app, { ne, or, isNull }) =>
            or(ne(app.gcaAddress, targetGcaAddress), isNull(app.gcaAddress)),
          columns: {
            id: true,
            gcaAddress: true,
            status: true,
            createdAt: true,
          },
        });

        if (applicationsToUpdate.length === 0) {
          return {
            message: "All applications already have the correct GCA address",
            targetGcaAddress,
            updated: 0,
          };
        }

        console.log(
          `Found ${applicationsToUpdate.length} applications to update`
        );

        // Update all applications to use the target GCA address
        const updateResult = await db
          .update(applications)
          .set({
            gcaAddress: targetGcaAddress,
            updatedAt: new Date(),
          })
          .where(
            or(
              not(eq(applications.gcaAddress, targetGcaAddress)),
              isNull(applications.gcaAddress)
            )
          )
          .returning({
            id: applications.id,
            gcaAddress: applications.gcaAddress,
          });

        console.log(
          `Successfully updated ${updateResult.length} applications with new GCA address`
        );

        set.status = 200;
        return {
          message: `Successfully updated ${updateResult.length} applications with new GCA address`,
          targetGcaAddress,
          updated: updateResult.length,
          totalFound: applicationsToUpdate.length,
          updatedApplications: updateResult.map((app) => ({
            id: app.id,
            newGcaAddress: app.gcaAddress,
          })),
        };
      } catch (error) {
        console.error("Error patching GCA address:", error);
        set.status = 500;
        return {
          message: "Error patching GCA address",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      detail: {
        summary: "Patch GCA address for all applications",
        description:
          "Updates the gcaAddress field for all applications to use the specified GCA address (0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd). " +
          "This is useful for standardizing GCA assignments across all applications.",
        tags: ["admin", "applications", "gca"],
      },
    }
  );
// .get("/anonymize-users-and-installers", async ({ set }) => {
//   if (process.env.NODE_ENV === "production") {
//     set.status = 404;
//     return { message: "Not allowed" };
//   }
//   try {
//     await db.transaction(async (tx) => {
//       // Anonymize users
//       const allUsers = await tx.query.users.findMany();
//       for (const user of allUsers) {
//         await updateUser(
//           {
//             firstName: "Anon",
//             lastName: "User",
//             email: `anon+${user.id}@example.com`,
//             companyName: "Anon Corp",
//             companyAddress: "123 Anon St",
//           },
//           user.id
//         );
//       }

//       // Anonymize installers
//       const allInstallers = await tx.query.installers.findMany();
//       for (const installer of allInstallers) {
//         await updateInstaller(
//           {
//             name: "Anon Installer",
//             email: `anon+${installer.id}@example.com`,
//             companyName: "Anon Installers",
//             phone: "000-000-0000",
//           },
//           installer.id
//         );
//       }

//       await tx
//         .update(applications)
//         .set({
//           userId: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
//           gcaAddress: "0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd",
//         })
//         .where(not(eq(applications.status, ApplicationStatusEnum.completed)));
//     });
//     return { message: "success" };
//   } catch (error) {
//     console.error("Error anonymizing users and installers", error);
//     return { message: "error" };
//   }
// });
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
