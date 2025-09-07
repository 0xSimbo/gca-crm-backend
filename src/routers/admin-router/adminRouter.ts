import { Elysia } from "elysia";
import {
  ApplicationEnquiryFieldsCRSInsertType,
  ApplicationInsertType,
  applications,
  deviceRewards,
  farmRewards,
  requirementSets,
  wallets,
  walletWeeklyRewards,
  zones,
} from "../../db/schema";
import { db } from "../../db/db";
import { and, eq, not, or, sql } from "drizzle-orm";
import postgres from "postgres";
import { PG_DATABASE_URL, PG_ENV } from "../../db/PG_ENV";
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
import {
  applicationsDraft,
  ApplicationsEncryptedMasterKeys,
  applicationsEnquiryFieldsCRS,
  applicationsAuditFieldsCRS,
  weeklyProduction,
  weeklyCarbonDebt,
  RewardSplits,
  Devices,
  farms,
  ApplicationPriceQuotes,
} from "../../db/schema";
import { RoundRobinStatusEnum } from "../../types/api-types/Application";
import { parseCoordinates } from "../../utils/parseCoordinates";
import { HubFarm } from "../../types/HubFarm";
import { getFarmsStatus } from "../devices/get-pubkeys-and-short-ids";
import { getProtocolFeePaymentFromTransactionHash } from "../../subgraph/queries/getProtocolFeePaymentFromTransactionHash";
import { getProtocolFeePaymentFromTxHashReceipt } from "../../utils/getProtocolFeePaymentFromTxHashReceipt";
import { getPubkeysAndShortIds } from "../devices/get-pubkeys-and-short-ids";
import { getRegionFromLatAndLng } from "../../utils/getRegionFromLatAndLng";
import { Coordinates } from "../../types/geography.types";
import { getDevicesLifetimeMetrics } from "../../crons/update-farm-rewards/get-devices-lifetime-metrics";
import { updateDeviceRewardsForWeek } from "../../crons/update-farm-rewards/update-device-rewards-for-week";
import { updateFarmRewardsForWeek } from "../../crons/update-farm-rewards/update-farm-rewards-for-week";

function parseAuditDate(input?: string): Date | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(
    /^(after|on or after|on|before|approx\.?|around)\s+/i,
    ""
  );
  const deordinal = withoutPrefix.replace(/(\d+)(st|nd|rd|th)/gi, "$1");

  const monthMap: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };

  // Try "Month Day Year" format (e.g., "April 16 2024")
  const rx1 =
    /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,)?\s+(\d{4})/i;
  const m1 = deordinal.match(rx1);
  if (m1) {
    const mi = monthMap[m1[1].toLowerCase()];
    const day = parseInt(m1[2], 10);
    const year = parseInt(m1[3], 10);
    if (!Number.isNaN(mi) && !Number.isNaN(day) && !Number.isNaN(year)) {
      return new Date(year, mi, day);
    }
  }

  // Try "Day of Month Year" format (e.g., "16 of April 2024")
  const rx2 =
    /(\d{1,2})\s+of\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})/i;
  const m2 = deordinal.match(rx2);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const mi = monthMap[m2[2].toLowerCase()];
    const year = parseInt(m2[3], 10);
    if (!Number.isNaN(mi) && !Number.isNaN(day) && !Number.isNaN(year)) {
      return new Date(year, mi, day);
    }
  }

  const fallback = new Date(deordinal);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return undefined;
}

async function patchFarmsFromAudits(dryRun: boolean = false) {
  const audits: HubFarm[] = await fetch(`https://glow.org/api/audits`).then(
    (r) => r.json()
  );
  if (!audits || audits.length === 0) {
    return {
      createdFarms: 0,
      createdDevices: 0,
      plannedFarms: [],
      plannedDevices: [],
    };
  }

  const allActiveShortIds = Array.from(
    new Set(
      audits.flatMap((a) => (a.activeShortIds || []).map((n) => String(n)))
    )
  );
  const allPrevShortIds = Array.from(
    new Set(
      audits.flatMap((a) => (a.previousShortIds || []).map((n) => String(n)))
    )
  );
  const allShortIds = Array.from(
    new Set([...allActiveShortIds, ...allPrevShortIds])
  );

  // Build shortId -> publicKey map from all known GCA server URLs
  const gcas = await db.query.Gcas.findMany();
  const serverUrls = Array.from(
    new Set(
      gcas.flatMap((g) => (Array.isArray(g.serverUrls) ? g.serverUrls : []))
    )
  );
  const shortIdToPubkey: Record<string, string> = {};
  for (const url of serverUrls) {
    try {
      const pairs = await getPubkeysAndShortIds(url);
      for (const p of pairs) {
        const key = String(p.shortId);
        if (!shortIdToPubkey[key]) shortIdToPubkey[key] = p.pubkey;
      }
    } catch (e) {
      console.error("error fetching pubkeys from", url, e);
    }
  }

  const existingDevices = await db.query.Devices.findMany({
    where: (d, { inArray }) => inArray(d.shortId, allShortIds),
    with: {
      farm: {
        columns: { id: true },
      },
    },
  });

  const shortIdToDevice: Record<string, any> = {};
  for (const dev of existingDevices) shortIdToDevice[dev.shortId] = dev;

  const { legacy } = await getFarmsStatus();

  let createdFarms = 0;
  let createdDevices = 0;
  const plannedFarms: Array<{
    name: string;
    zoneId: number;
    auditCompleteDate: string;
    protocolFeePaymentHash: string;
    gcaId: string;
    userId: string;
    rewardSplits: Array<{
      walletAddress: string;
      glowSplitPercent: string;
      usdgSplitPercent: string;
    }>;
    activeShortIds: string[];
  }> = [];
  const plannedDevices: Array<{
    shortId: string;
    farmId: string | null;
    farmName: string;
  }> = [];

  for (const auditEntry of audits) {
    const auditShortIds = (auditEntry.activeShortIds || []).map((n) =>
      String(n)
    );
    const prevShortIds = (auditEntry.previousShortIds || []).map((n) =>
      String(n)
    );
    if (auditShortIds.length === 0) continue;

    const existingAny = auditShortIds
      .map((sid) => shortIdToDevice[sid])
      .find(Boolean);

    let targetFarmId: string | null = existingAny
      ? (existingAny.farmId as string)
      : null;

    if (!existingAny) {
      const legacyHit = legacy.find((l) =>
        auditShortIds.some((sid) => l.short_id === Number(sid))
      );
      if (!legacyHit) {
        console.log(
          "No legacy hit found for farm",
          auditEntry.humanReadableName
        );
        continue;
      }
      const auditDate = new Date(legacyHit.timestamp_audited_completed * 1000);
      const paymentTxHash = legacyHit?.payment_tx_hash || `0x${"0".repeat(64)}`;
      const rewardSplit = legacyHit?.reward_splits;

      if (!rewardSplit || rewardSplit.length === 0) {
        console.log("No reward split found for farm", auditEntry.farmName);
        continue;
      }

      if (!auditEntry.summary.address.coordinates) {
        console.log(
          "No coordinates found for farm",
          auditEntry.humanReadableName
        );
        continue;
      }

      const receipt = legacyHit
        ? await getProtocolFeePaymentFromTransactionHash(paymentTxHash)
        : null;
      const ownerUserId =
        receipt?.user?.id || "0x0000000000000000000000000000000000000000";
      const region = await getRegionFromLatAndLng(
        String(parseCoordinates(auditEntry.summary.address.coordinates)?.lat),
        String(parseCoordinates(auditEntry.summary.address.coordinates)?.lng)
      );
      console.log("region", region);
      const farmValues = {
        zoneId: 1,
        auditCompleteDate: auditDate,
        protocolFeePaymentHash: paymentTxHash,
        gcaId: "0x63a74612274FbC6ca3f7096586aF01Fd986d69cE",
        userId: ownerUserId,
        name:
          (auditEntry.humanReadableName as string | undefined) || "__UNSET__",
        region: region?.region,
        regionFullName: region?.regionFullName,
        signalType: region?.signalType,
      };

      if (dryRun) {
        plannedFarms.push({
          name: farmValues.name,
          zoneId: farmValues.zoneId,
          auditCompleteDate: farmValues.auditCompleteDate.toISOString(),
          protocolFeePaymentHash: farmValues.protocolFeePaymentHash,
          gcaId: farmValues.gcaId,
          userId: farmValues.userId,
          rewardSplits: rewardSplit.map((r: any) => ({
            walletAddress: r.walletAddress,
            glowSplitPercent: r.glowSplitPercent.toString(),
            usdgSplitPercent: r.usdgSplitPercent.toString(),
          })),
          activeShortIds: auditShortIds,
        });
        createdFarms += 1;
      } else {
        await db.transaction(async (tx) => {
          const farmInsert = await tx
            .insert(farms)
            .values(farmValues)
            .returning({ id: farms.id });

          if (rewardSplit.length > 0) {
            await tx.insert(RewardSplits).values(
              rewardSplit.map((r: any) => ({
                farmId: farmInsert[0].id,
                walletAddress: r.walletAddress,
                glowSplitPercent: r.glowSplitPercent.toString(),
                usdgSplitPercent: r.usdgSplitPercent.toString(),
              }))
            );
          }

          targetFarmId = farmInsert[0].id;
          createdFarms += 1;

          for (const sid of auditShortIds) {
            if (!shortIdToDevice[sid]) {
              const mappedPub = shortIdToPubkey[sid] || `unknown_short_${sid}`;
              const deviceInsert = await tx
                .insert(Devices)
                .values({
                  farmId: targetFarmId!,
                  publicKey: mappedPub,
                  shortId: sid,
                  isEnabled: true,
                  enabledAt: auditDate,
                  previousPublicKey:
                    prevShortIds.length > 0
                      ? shortIdToPubkey[prevShortIds[0]]
                      : null,
                })
                .returning({ id: Devices.id, shortId: Devices.shortId });
              shortIdToDevice[sid] = {
                ...deviceInsert[0],
                farmId: targetFarmId,
              } as any;
              createdDevices += 1;
            }
          }
          for (const sid of prevShortIds) {
            if (!shortIdToDevice[sid]) {
              const mappedPub =
                shortIdToPubkey[sid] || `unknown_prev_short_${sid}`;
              const deviceInsert = await tx
                .insert(Devices)
                .values({
                  farmId: targetFarmId!,
                  publicKey: mappedPub,
                  shortId: sid,
                  isEnabled: false,
                  enabledAt: auditDate,
                })
                .returning({ id: Devices.id, shortId: Devices.shortId });
              shortIdToDevice[sid] = {
                ...deviceInsert[0],
                farmId: targetFarmId,
              } as any;
              createdDevices += 1;
            }
          }
        });
      }
    }

    if (dryRun) {
      // plan devices for a new farm
      for (const sid of auditShortIds) {
        if (!shortIdToDevice[sid]) {
          plannedDevices.push({
            shortId: sid,
            farmId: null,
            farmName:
              (auditEntry.humanReadableName as string | undefined) ||
              "__UNSET__",
          });
          shortIdToDevice[sid] = { id: `planned_${sid}`, farmId: null } as any;
          createdDevices += 1;
        }
      }
      for (const sid of prevShortIds) {
        if (!shortIdToDevice[sid]) {
          plannedDevices.push({
            shortId: sid,
            farmId: null,
            farmName:
              (auditEntry.humanReadableName as string | undefined) ||
              "__UNSET__",
          });
          shortIdToDevice[sid] = { id: `planned_${sid}`, farmId: null } as any;
          createdDevices += 1;
        }
      }
    }
  }

  return { createdFarms, createdDevices, plannedFarms, plannedDevices };
}

export const adminRouter = new Elysia({ prefix: "/admin" })
  .get(
    "/create-completed-application-from-sources",
    async ({ set }) => {
      try {
        if (process.env.NODE_ENV === "production") {
          set.status = 404;
          return { message: "Not allowed" };
        }

        // Ensure all farms from audits exist before proceeding
        await patchFarmsFromAudits();

        let applicationsPatch = [];
        const allFarmsWithoutApplications = await db.query.farms.findMany({
          columns: {
            id: true,
            userId: true,
            zoneId: true,
            gcaId: true,
            name: true,
          },
        });

        for (const farm of allFarmsWithoutApplications) {
          const farmIdParam = farm.id;

          const matchingApplication = await db.query.applications.findFirst({
            where: (a, { eq }) => eq(a.farmId, farmIdParam),
          });

          if (matchingApplication) {
            continue;
          }

          const devices = await db.query.Devices.findMany({
            where: (d, { eq }) => eq(d.farmId, farmIdParam),
          });

          if (devices.length === 0) {
            set.status = 400;
            return { message: "Farm has no devices" };
          }

          function toBigIntFrom6Decimals(value?: string) {
            if (!value) return BigInt(0);
            const [intPart, fracPartRaw = ""] = value.split(".");
            const fracPart = (fracPartRaw + "000000").slice(0, 6);
            return BigInt(intPart + fracPart);
          }

          const userId = farm.userId;
          const zoneId = farm.zoneId || 1;
          const gcaAddress = farm.gcaId;
          const now = new Date();

          const { legacy } = await getFarmsStatus();

          const legacyFarm = legacy.find((f) =>
            devices.find((d) => f.short_id === Number(d.shortId))
          );

          // Fetch audits API and locate entry
          const audits: HubFarm[] = await fetch(
            `https://glow.org/api/audits`
          ).then((r) => r.json());
          const auditEntry = audits.find((a) =>
            devices.find(
              (d) =>
                a.activeShortIds.includes(Number(d.shortId)) ||
                a.previousShortIds.includes(Number(d.shortId))
            )
          );

          if (!legacyFarm || !auditEntry) {
            set.status = 404;
            return {
              message:
                "Legacy or audit data not found for farm " +
                farm.id +
                " " +
                farm.name,
            };
          }

          const finalProtocolFeeStr =
            auditEntry.summary.carbonFootprintAndProduction.protocolFees.replace(
              /[^0-9.]/g,
              ""
            );
          const paymentTxHash = legacyFarm.payment_tx_hash;

          const electricityPriceStr =
            auditEntry?.summary?.installationAndOperations?.electricityPrice?.replace(
              /[^0-9.]/g,
              ""
            );
          const addressLocation =
            auditEntry?.summary?.address?.location || farm.name || "unknown";
          const coordsStr = auditEntry?.summary?.address?.coordinates || "";
          const coords = parseCoordinates(coordsStr);
          const latStr = coords ? String(coords.lat) : "0";
          const lngStr = coords ? String(coords.lng) : "0";
          const avgSunStr =
            auditEntry?.summary?.carbonFootprintAndProduction?.averageSunlightPerDay?.replace(
              /[^0-9.]/g,
              ""
            );
          const adjWeeklyCreditsStr =
            auditEntry?.summary?.carbonFootprintAndProduction?.adjustedWeeklyCarbonCredit?.replace(
              /[^0-9.]/g,
              ""
            );
          const weeklyDebtStr =
            auditEntry?.summary?.carbonFootprintAndProduction?.weeklyTotalCarbonDebt?.replace(
              /[^0-9.]/g,
              ""
            );
          const netWeeklyStr =
            auditEntry?.summary?.carbonFootprintAndProduction?.netCarbonCreditEarningWeekly?.replace(
              /[^0-9.]/g,
              ""
            );
          const systemWattageOutput = auditEntry?.summary
            ?.carbonFootprintAndProduction?.systemWattageOutput as
            | string
            | undefined;

          const matchDC = systemWattageOutput?.match(/([0-9.]+)\s*kW\s*DC/i);

          const dcKW = matchDC ? Number(matchDC[1]) : undefined;
          const estimatedKWhPerYear = dcKW ? String(dcKW) : 0;
          const enquiryEstimatedQuotePerWatt = electricityPriceStr;

          const panelsQty = auditEntry?.summary?.solarPanels?.quantity as
            | number
            | undefined;
          const panelsBrand = auditEntry?.summary?.solarPanels
            ?.brandAndModel as string | undefined;
          const panelsWarranty = auditEntry?.summary?.solarPanels?.warranty as
            | string
            | undefined;
          const ptoDateStr = auditEntry?.summary?.installationAndOperations
            ?.ptoDate as string | undefined;
          const ptoDate = parseAuditDate(ptoDateStr);
          const installDateStr = auditEntry?.summary?.installationAndOperations
            ?.installationDate as string | undefined;
          const auditCompleteDate = parseAuditDate(auditEntry?.auditDate);
          const installDate = parseAuditDate(installDateStr);

          const receipt = await getProtocolFeePaymentFromTransactionHash(
            paymentTxHash
          );

          if (!receipt) {
            set.status = 404;
            return { message: "Receipt not found" };
          }

          const paymentDate = new Date(Number(receipt.blockTimestamp) * 1000);

          await db.transaction(async (tx) => {
            const [draft] = await tx
              .insert(applicationsDraft)
              .values({ createdAt: paymentDate, userId })
              .returning();

            await tx
              .update(farms)
              .set({
                auditCompleteDate,
              })
              .where(eq(farms.id, farm.id));

            const app: ApplicationInsertType = {
              id: draft.id,
              userId,
              zoneId,
              farmId: farm.id,
              createdAt: installDate || now,
              currentStep: ApplicationSteps.payment,
              roundRobinStatus: RoundRobinStatusEnum.assigned,
              status: ApplicationStatusEnum.completed,
              isCancelled: false,
              isDocumentsCorrupted: false,
              gcaAddress,
              gcaAssignedTimestamp: installDate || paymentDate,
              gcaAcceptanceTimestamp: paymentDate || paymentDate,
              gcaAcceptanceSignature: null,
              installFinishedDate: installDate || paymentDate,
              revisedKwhGeneratedPerYear: estimatedKWhPerYear.toString(),
              revisedCostOfPowerPerKWh: electricityPriceStr || null,
              finalProtocolFee: toBigIntFrom6Decimals(finalProtocolFeeStr),
              paymentDate,
              paymentTxHash: paymentTxHash,
              additionalPaymentTxHash: null,
              paymentCurrency: "USDG",
              paymentEventType: "PayProtocolFee",
              payer: receipt.user.id,
              allowedZones: [1],
              finalQuotePerWatt: electricityPriceStr,
            };

            // console.log("app", app);

            const applicationInsert = await tx
              .insert(applications)
              .values(app)
              .returning({
                id: applications.id,
              });

            if (auditEntry.auditDocuments.length > 0) {
              await tx.insert(Documents).values(
                auditEntry.auditDocuments.map((a) => ({
                  applicationId: applicationInsert[0].id,
                  name: a.name,
                  createdAt: new Date(),
                  step: ApplicationSteps.payment,
                  url: a.link,
                  type: a.link.split(".").pop() || "pdf",
                }))
              );
            }
            if (
              auditEntry.afterInstallPictures &&
              auditEntry.afterInstallPictures.length > 0
            ) {
              await tx.insert(Documents).values(
                auditEntry.afterInstallPictures.map((a, i) => ({
                  applicationId: applicationInsert[0].id,
                  name: `misc_after_install_pictures_img_${i}`,
                  createdAt: new Date(),
                  step: ApplicationSteps.payment,
                  url: a.link,
                  type: a.link.split(".").pop() || "jpg",
                }))
              );
            }
            if (
              auditEntry.preInstallPictures &&
              auditEntry.preInstallPictures.length > 0
            ) {
              await tx.insert(Documents).values(
                auditEntry.preInstallPictures.map((a, i) => ({
                  applicationId: applicationInsert[0].id,
                  name: `misc_pre_install_pictures_img_${i}`,
                  createdAt: new Date(),
                  step: ApplicationSteps.payment,
                  url: a.link,
                  type: a.link.split(".").pop() || "jpg",
                }))
              );
            }

            await tx.insert(ApplicationsEncryptedMasterKeys).values({
              applicationId: draft.id,
              userId,
              encryptedMasterKey: "",
            });

            const enquiryFieldsCRS: ApplicationEnquiryFieldsCRSInsertType = {
              applicationId: draft.id,
              address: addressLocation,
              farmOwnerName: "unknown-owner",
              farmOwnerEmail: "owner@example.com",
              farmOwnerPhone: "0000000000",
              lat: latStr,
              lng: lngStr,
              estimatedCostOfPowerPerKWh: electricityPriceStr || "0",
              estimatedKWhGeneratedPerYear: estimatedKWhPerYear.toString(),
              enquiryEstimatedFees: finalProtocolFeeStr,
              enquiryEstimatedQuotePerWatt: enquiryEstimatedQuotePerWatt,
              estimatedAdjustedWeeklyCredits: adjWeeklyCreditsStr || "0",
              installerName: "Jeff  Barlow",
              installerCompanyName: "Glow Solutions LLC ",
              installerEmail: "Jeff@glowsolutions.org",
              installerPhone: "8016313214",
            };

            await tx
              .insert(applicationsEnquiryFieldsCRS)
              .values(enquiryFieldsCRS);

            await tx.insert(applicationsAuditFieldsCRS).values({
              applicationId: draft.id,
              averageSunlightHoursPerDay: avgSunStr || "0",
              adjustedWeeklyCarbonCredits: adjWeeklyCreditsStr || "0",
              weeklyTotalCarbonDebt: weeklyDebtStr || "0",
              netCarbonCreditEarningWeekly: netWeeklyStr || "0",
              solarPanelsQuantity: panelsQty,
              solarPanelsBrandAndModel: panelsBrand,
              solarPanelsWarranty: panelsWarranty?.replace(/[^0-9.]/g, ""),
              finalEnergyCost: electricityPriceStr,
              systemWattageOutput: systemWattageOutput,
              ptoObtainedDate: ptoDate,
              locationWithoutPII: addressLocation,
              revisedInstallFinishedDate: installDate,
              devices: devices,
            });

            await tx.insert(weeklyProduction).values({
              applicationId: draft.id,
              createdAt: new Date(),
              powerOutputMWH: "0.01066",
              hoursOfSunlightPerDay: "5.71",
              carbonOffsetsPerMWH: "0.4402",
              adjustmentDueToUncertainty: "0.35",
              weeklyPowerProductionMWh: "0.4260802",
              weeklyCarbonCredits: "0.187560504",
              adjustedWeeklyCarbonCredits: "0.1219143276",
            });

            await tx.insert(weeklyCarbonDebt).values({
              applicationId: draft.id,
              createdAt: new Date(),
              totalCarbonDebtAdjustedKWh: "3.1104",
              convertToKW: "10.66",
              totalCarbonDebtProduced: "33.156864",
              disasterRisk: "0.0017",
              commitmentPeriod: 10,
              adjustedTotalCarbonDebt: "33.71476342",
              weeklyTotalCarbonDebt: "0.06483608349",
            });

            return draft.id;
          });
          console.log("Application created for farm", farm.id);
        }
        set.status = 201;
        return { message: "success" };
        // return { message: "success", applicationsPatch };
      } catch (error) {
        console.error("Error creating application from sources", error);
        set.status = 500;
        return { message: "error" };
      }
    },
    {
      detail: {
        summary:
          "Dev-only: Create completed application linked to a farm from legacy JSON and audits API",
        description:
          "Derives data from src/db/scripts/legacy-farms.json and https://glow.org/api/audits, then creates a completed application with required relations.",
        tags: ["admin", "applications"],
      },
    }
  )
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
  });
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
