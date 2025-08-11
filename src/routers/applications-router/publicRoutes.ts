import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import {
  findAllCompletedApplications,
  findCompletedApplication,
} from "../../db/queries/applications/findAllCompletedApplications";
import { findAllWaitingForPaymentApplications } from "../../db/queries/applications/findAllWaitingForPaymentApplications";
import {
  FindFirstApplicationById,
  FindFirstApplicationByIdMinimal,
} from "../../db/queries/applications/findFirstApplicationById";
import { getForwarderDataFromTxHashReceipt } from "../../utils/getForwarderDataFromTxHashReceipt";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  RoundRobinStatusEnum,
} from "../../types/api-types/Application";
import {
  DECIMALS_BY_CURRENCY,
  forwarderAddresses,
} from "../../constants/addresses";
import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { createGlowEventEmitter, eventTypes } from "@glowlabs-org/events-sdk";
import {
  findUsedAuditFeesTxHash,
  findUsedTxHash,
} from "../../db/queries/applications/findUsedTxHash";
import { db } from "../../db/db";
import {
  applicationsDraft,
  applications,
  ApplicationsEncryptedMasterKeys,
  applicationsEnquiryFieldsCRS,
  weeklyProduction,
  weeklyCarbonDebt,
  ApplicationPriceQuotes,
  RewardSplits,
  applicationsAuditFieldsCRS,
  ApplicationAuditFieldsCRSInsertType,
  Devices,
} from "../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { completeApplicationWithDocumentsAndCreateFarmWithDevices } from "../../db/mutations/applications/completeApplicationWithDocumentsAndCreateFarm";
import { getPubkeysAndShortIds } from "../devices/get-pubkeys-and-short-ids";

export const publicApplicationsRoutes = new Elysia()
  .get(
    "/completed",
    async ({ query: { withDocuments }, set }) => {
      try {
        const applications = await findAllCompletedApplications(
          !!withDocuments
        );
        return applications;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[applicationsRouter] /completed", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        withDocuments: t.Optional(t.Literal("true")),
      }),
      detail: {
        summary: "Get all completed applications ",
        description: `Get all completed applications `,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/waiting-for-payment",
    async ({ query: { isPublishedOnAuction }, set }) => {
      try {
        const applications = await findAllWaitingForPaymentApplications(
          isPublishedOnAuction === "true"
            ? true
            : isPublishedOnAuction === "false"
            ? false
            : undefined
        );

        return applications;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[applicationsRouter] /waiting-for-payment", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        isPublishedOnAuction: t.Optional(
          t.Union([t.Literal("true"), t.Literal("false")])
        ),
      }),
      detail: {
        summary: "Get all waiting for payment applications",
        description: `Get all applications that are waiting for payment, optionally filtered by auction publication status. Returns an array of application objects with zone, enquiry fields, reward splits, weekly carbon debt, and weekly production data.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/completed/by",
    async ({ query, set }) => {
      try {
        const { farmId, publicKey, shortId } = query;
        if (!farmId && !publicKey && !shortId) {
          set.status = 400;
          return "You must provide one of: farmId, publicKey, or shortId";
        }
        const application = await findCompletedApplication({
          farmId,
          publicKey,
          shortId,
        });
        if (!application) {
          set.status = 404;
          return "Completed application not found";
        }
        return application;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        farmId: t.Optional(t.String()),
        publicKey: t.Optional(t.String()),
        shortId: t.Optional(t.String()),
      }),
      detail: {
        summary:
          "Get one completed application by farmId, publicKey, or shortId",
        description: `Returns a completed application for a farm or device. Prioritizes: publicKey > shortId > farmId.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/by-application-id",
    async ({ query, set }) => {
      try {
        const { applicationId } = query;
        if (!applicationId) {
          set.status = 400;
          return "You must provide an applicationId";
        }
        const application = await FindFirstApplicationByIdMinimal(
          applicationId
        );
        if (!application) {
          set.status = 404;
          return "Application not found";
        }
        const {
          finalProtocolFee,
          auditFees,
          auditFeesTxHash,
          auditFeesPaymentDate,
          status,
          currentStep,
          isCancelled,
          createdAt,
          zone,
          user,
          gca,
          applicationPriceQuotes,
        } = application;
        return {
          finalProtocolFee,
          auditFees,
          auditFeesTxHash,
          auditFeesPaymentDate,
          status,
          currentStep,
          isCancelled,
          createdAt,
          zone,
          walletAddress: user.id,
          gcaAddress: gca?.id,
          applicationPriceQuotes,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        applicationId: t.String(),
      }),
      detail: {
        summary: "Get one application by applicationId",
        description: `Returns a application by applicationId`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/finalize-payment",
    async ({ body, set, headers }) => {
      try {
        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          set.status = 400;
          return "API Key is required";
        }
        if (apiKey !== process.env.GUARDED_API_KEY) {
          set.status = 401;
          return "Unauthorized";
        }

        const usedTxHash = await findUsedTxHash(body.txHash);

        if (usedTxHash) {
          set.status = 400;
          return "Transaction hash already been used";
        }

        const forwarderData = await getForwarderDataFromTxHashReceipt(
          body.txHash
        );

        const applicationId = forwarderData.applicationId;

        const application = await FindFirstApplicationById(applicationId);

        if (!application) {
          set.status = 404;
          return `Application not found: ${applicationId}`;
        }

        if (application.status !== ApplicationStatusEnum.waitingForPayment) {
          set.status = 400;
          return "Application is not waiting for payment";
        }

        if (BigInt(application.finalProtocolFeeBigInt) === BigInt(0)) {
          console.error("Final Protocol Fee is not set");
          set.status = 400;
          return "Final Protocol Fee is not set";
        }

        const currency = forwarderData.paymentCurrency;

        if (!(currency in DECIMALS_BY_CURRENCY)) {
          console.error("Unsupported payment currency", currency);
          set.status = 400;
          return `Unsupported payment currency: ${currency}`;
        }

        const quotes = await db
          .select()
          .from(ApplicationPriceQuotes)
          .where(eq(ApplicationPriceQuotes.applicationId, applicationId));

        if (quotes.length === 0) {
          console.error("No price quotes found for application", applicationId);
          set.status = 400;
          return `No price quotes found for application: ${applicationId}`;
        }

        const latestQuote = quotes.sort((a, b) => {
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        })[0];

        // Reject stale quotes (>= 16 weeks old)
        const sixteenWeeksInMs = 16 * 7 * 24 * 60 * 60 * 1000;
        const quoteAgeMs =
          Date.now() - new Date(latestQuote.createdAt).getTime();
        if (quoteAgeMs >= sixteenWeeksInMs) {
          console.error(
            "Latest price quote is stale (>= 16 weeks) and must be requoted by the GVE"
          );
          set.status = 400;
          return "Latest price quote is stale (>= 16 weeks) and must be requoted by the GVE";
        }

        const prices = latestQuote.prices;

        const pricePerTokenScaled6 = prices[currency];

        if (
          pricePerTokenScaled6 === undefined ||
          pricePerTokenScaled6 === "" ||
          BigInt(pricePerTokenScaled6) === BigInt(0)
        ) {
          console.error(
            "Invalid price per token (scaled 1e6)",
            pricePerTokenScaled6
          );
          set.status = 400;
          return `Invalid price per token (scaled 1e6): ${pricePerTokenScaled6}`;
        }

        const finalFee = BigInt(application.finalProtocolFeeBigInt);

        if (!finalFee) {
          console.error("Invalid final fee", finalFee);
          set.status = 400;
          return `Invalid final fee: ${finalFee}`;
        }

        if (BigInt(forwarderData.amount) === BigInt(0)) {
          console.error("Invalid amount: 0");
          set.status = 400;
          return `Invalid amount: 0`;
        }

        if (!application.zoneId) {
          set.status = 400;
          return "Zone is not set";
        }

        if (!application.userId) {
          set.status = 400;
          return "User is not set";
        }

        if (!application.gcaAddress) {
          set.status = 400;
          return "GCA is not set";
        }

        if (
          !application.enquiryFields?.lat ||
          !application.enquiryFields?.lng
        ) {
          set.status = 400;
          return "Lat or lng is not set";
        }

        if (!application.enquiryFields?.farmOwnerName) {
          set.status = 400;
          return "Farm owner name is not set";
        }

        if (
          !application.auditFields?.devices ||
          application.auditFields?.devices.length === 0
        ) {
          set.status = 400;
          return "Devices are not set";
        }

        await completeApplicationWithDocumentsAndCreateFarmWithDevices({
          protocolFeePaymentHash: body.txHash,
          paymentDate: forwarderData.paymentDate,
          paymentCurrency: forwarderData.paymentCurrency,
          paymentEventType: forwarderData.eventType,
          applicationId,
          gcaId: application.gcaAddress,
          userId: application.userId,
          devices: application.auditFields?.devices,
          protocolFee: BigInt(application.finalProtocolFeeBigInt),
          protocolFeeAdditionalPaymentTxHash: null,
          lat: application.enquiryFields?.lat,
          lng: application.enquiryFields?.lng,
          farmName: application.enquiryFields?.farmOwnerName,
          payer: forwarderData.from,
        });
        if (process.env.NODE_ENV === "production") {
          const emitter = createGlowEventEmitter({
            username: process.env.RABBITMQ_ADMIN_USER!,
            password: process.env.RABBITMQ_ADMIN_PASSWORD!,
            zoneId: application.zoneId,
          });

          emitter
            .emit({
              eventType: eventTypes.auditPfeesPaid,
              schemaVersion: "v2-alpha",
              payload: {
                applicationId: applicationId,
                payer: forwarderData.from,
                amount_6Decimals: forwarderData.amount,
                txHash: body.txHash,
                paymentCurrency: forwarderData.paymentCurrency,
                paymentEventType: forwarderData.eventType,
                isSponsored: false,
              },
            })
            .catch((e) => {
              console.error("error with audit.pfees.paid event", e);
            });
        }

        return application;
      } catch (e) {
        if (e instanceof Error) {
          console.error("Error in finalize-payment", e);
          set.status = 400;
          return e.message;
        }
        console.error("[applicationsRouter] finalize-payment", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        txHash: t.String(),
      }),
      detail: {
        summary: "Finalize Payment",
        description: `Finalize Payment and update the application status to paymentConfirmed`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/finalize-audit-fees-payment",
    async ({ body, set, headers }) => {
      try {
        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          set.status = 400;
          return "API Key is required";
        }
        if (apiKey !== process.env.GUARDED_API_KEY) {
          set.status = 401;
          return "Unauthorized";
        }

        const usedTxHash = await findUsedAuditFeesTxHash(body.txHash);

        if (usedTxHash) {
          set.status = 400;
          return "Transaction hash already been used";
        }

        const forwarderData = await getForwarderDataFromTxHashReceipt(
          body.txHash
        );

        const applicationId = forwarderData.applicationId;

        const application = await FindFirstApplicationById(applicationId);

        if (!application) {
          set.status = 404;
          return `Application not found: ${applicationId}`;
        }

        if (forwarderData.to !== forwarderAddresses.AUDIT_FEE_WALLET) {
          set.status = 400;
          return "Invalid forwarder address";
        }

        if (BigInt(application.auditFees) === BigInt(0)) {
          console.error("Final Protocol Fee is not set");
          set.status = 400;
          return "Final Protocol Fee is not set";
        }

        const currency = forwarderData.paymentCurrency;

        if (currency !== "USDC") {
          console.error("Unsupported payment currency", currency);
          set.status = 400;
          return `Unsupported payment currency: ${currency}`;
        }

        if (BigInt(forwarderData.amount) === BigInt(0)) {
          console.error("Invalid amount: 0");
          set.status = 400;
          return `Invalid amount: 0`;
        }

        if (
          application.auditFeesTxHash &&
          application.auditFeesTxHash !== body.txHash
        ) {
          set.status = 400;
          return "Audit fees tx hash already been used";
        }

        await updateApplication(applicationId, {
          auditFeesTxHash: body.txHash,
          auditFeesPaymentDate: forwarderData.paymentDate,
        });

        if (process.env.NODE_ENV === "production") {
          const emitter = createGlowEventEmitter({
            username: process.env.RABBITMQ_ADMIN_USER!,
            password: process.env.RABBITMQ_ADMIN_PASSWORD!,
            zoneId: application.zoneId,
          });

          emitter
            .emit({
              eventType: eventTypes.auditorFeesPaid,
              schemaVersion: "v2-alpha",
              payload: {
                applicationId: applicationId,
                payer: forwarderData.from,
                amount_6Decimals: forwarderData.amount,
                txHash: body.txHash,
              },
            })
            .catch((e) => {
              console.error("error with audit.pfees.paid event", e);
            });
        }

        return application;
      } catch (e) {
        if (e instanceof Error) {
          console.error("Error in finalize-payment", e);
          set.status = 400;
          return e.message;
        }
        console.error("[applicationsRouter] finalize-payment", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        txHash: t.String(),
      }),
      detail: {
        summary: "Finalize Payment",
        description: `Finalize Payment and update the application status to paymentConfirmed`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/dev-create-application",
    async ({ headers, set }) => {
      try {
        // Only accessible in non-production environments
        if (process.env.NODE_ENV === "production") {
          set.status = 404;
          return "Not allowed";
        }

        // API key validation
        // const apiKey = headers["x-api-key"];
        // if (!apiKey) {
        //   set.status = 400;
        //   return "API Key is required";
        // }
        // if (apiKey !== process.env.GUARDED_API_KEY) {
        //   set.status = 401;
        //   return "Unauthorized";
        // }

        const applicationId = await db.transaction(async (tx) => {
          const [applicationDraft] = await tx
            .insert(applicationsDraft)
            .values({
              createdAt: new Date(),
              userId: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
            })
            .returning();

          await tx.insert(applications).values({
            id: applicationDraft.id,
            userId: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
            zoneId: 1,
            createdAt: new Date(),
            currentStep: ApplicationSteps.payment,
            roundRobinStatus: RoundRobinStatusEnum.assigned,
            status: ApplicationStatusEnum.waitingForPayment,
            isCancelled: false,
            isDocumentsCorrupted: true,
            gcaAcceptanceSignature: null,
            gcaAddress: "0x63a74612274FbC6ca3f7096586aF01Fd986d69cE",
            gcaAssignedTimestamp: new Date(),
            gcaAcceptanceTimestamp: new Date(),
            installFinishedDate: new Date(),
            revisedCostOfPowerPerKWh: "1.20",
            revisedKwhGeneratedPerYear: "7.90",
            finalQuotePerWatt: "1.20",
            estimatedInstallDate: new Date(),
            preInstallVisitDate: new Date(),
            preInstallVisitDateConfirmedTimestamp: new Date(),
            afterInstallVisitDate: new Date(),
            afterInstallVisitDateConfirmedTimestamp: new Date(),
            finalProtocolFee: BigInt(12668490000),
            revisedEstimatedProtocolFees: "12668",
          });

          await tx.insert(ApplicationsEncryptedMasterKeys).values({
            applicationId: applicationDraft.id,
            userId: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
            encryptedMasterKey:
              "Il7u5piKaYbRYY6HGNxzabsb25Bb/hcTZwoprPv6cWqlsXfXeXeJ4FQrPmca2n6imFkfXGkmETSjtYJ3i2LurLA9tpYACOfzCqDubFe7sBKeYBQm4gf3kTS3zn6UIsFglpUAtYLewhBicYkTKq2wkfmDJqxc4hn4VASo3cTNnKCq43ecPWLTPqXn6LHfIy3l3yPaPeW/bx/Y0Y9eA+aZAR19EqfmGL57MJE+jvEdh7VPo7Z6kAG0WdYn4eGyzLbcsl/j8kQYxHpONs9SDLjXrUY0ILN9ul0LSDuOzwJYWn8k6JaKH+mdoFTdYybJ7OzzsdmxD11Sxu2b8gwRFVJntg==",
          });

          await tx.insert(applicationsEnquiryFieldsCRS).values({
            applicationId: applicationDraft.id,
            address: "sentinel-address",
            farmOwnerName: "sentinel-owner",
            farmOwnerEmail: "owner@example.com",
            farmOwnerPhone: "0000000000",
            lat: "41.94593",
            lng: "-111.83126",
            estimatedCostOfPowerPerKWh: "0.13",
            estimatedKWhGeneratedPerYear: "7.9",
            enquiryEstimatedFees: "2216207000",
            enquiryEstimatedQuotePerWatt: "0.13",
            installerName: "sentinel-installer",
            installerCompanyName: "sentinel-company",
            installerEmail: "installer@example.com",
            installerPhone: "0000000000",
          });

          const pubKeysAndShortIds = await getPubkeysAndShortIds(
            "http://95.217.194.59:35015"
          );

          if (!pubKeysAndShortIds.length) {
            return [];
          }

          const devicesAlreadyInDb = await db.query.Devices.findMany({
            where: inArray(
              Devices.publicKey,
              pubKeysAndShortIds.map((c) => c.pubkey)
            ),
          });
          const availableDevices = pubKeysAndShortIds.filter(
            (d) => !devicesAlreadyInDb.find((db) => db.publicKey === d.pubkey)
          );

          const auditFields: ApplicationAuditFieldsCRSInsertType = {
            applicationId: applicationDraft.id,
            createdAt: new Date(),
            finalEnergyCost: "12668",
            solarPanelsQuantity: 1,
            solarPanelsBrandAndModel: "sentinel-brand-model",
            solarPanelsWarranty: "10",
            ptoObtainedDate: new Date("2025-01-01"),
            locationWithoutPII: "sentinel-location",
            revisedInstallFinishedDate: new Date("2025-01-01"),
            averageSunlightHoursPerDay: "4.74816609",
            adjustedWeeklyCarbonCredits: "0.11500758",
            weeklyTotalCarbonDebt: "0.04806365",
            netCarbonCreditEarningWeekly: "0.11500758",
            devices: [
              {
                publicKey: availableDevices[0].pubkey,
                shortId: availableDevices[0].shortId.toString(),
              },
            ],
            systemWattageOutput: "1000",
          };
          await tx.insert(applicationsAuditFieldsCRS).values(auditFields);

          await tx.insert(weeklyProduction).values({
            applicationId: applicationDraft.id,
            createdAt: new Date(),
            powerOutputMWH: "0.0079",
            hoursOfSunlightPerDay: "4.74816609",
            carbonOffsetsPerMWH: "0.67384823",
            adjustmentDueToUncertainty: "0.35",
            weeklyPowerProductionMWh: "0.26257358",
            weeklyCarbonCredits: "0.17693474",
            adjustedWeeklyCarbonCredits: "0.11500758",
          });

          await tx.insert(weeklyCarbonDebt).values({
            applicationId: applicationDraft.id,
            createdAt: new Date(),
            totalCarbonDebtAdjustedKWh: "3.1104",
            convertToKW: "7.9",
            totalCarbonDebtProduced: "24.57216",
            disasterRisk: "0.0017",
            commitmentPeriod: 10,
            adjustedTotalCarbonDebt: "24.99309686",
            weeklyTotalCarbonDebt: "0.04806365",
          });

          await tx.insert(ApplicationPriceQuotes).values({
            applicationId: applicationDraft.id,
            createdAt: new Date(),
            prices: {
              GCTL: "450000",
              GLW: "414652",
              USDC: "1000000",
              USDG: "1000000",
            },
            signature:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            gcaAddress: "0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd",
          });

          await tx.insert(RewardSplits).values({
            walletAddress: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
            glowSplitPercent: "1",
            usdgSplitPercent: "1",
          });

          return applicationDraft.id;
        });

        return { applicationId };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[applicationsRouter] dev-create-application", e);
        throw new Error("Error Occured");
      }
    },
    {
      detail: {
        summary: "Dev-only: Create application at waiting-for-payment step",
        description: `Create a new application pre-populated with sentinel values and immediately set to waiting-for-payment. Accessible only when NODE_ENV is not production and with a valid x-api-key.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/application-price-quotes",
    async ({ query, set }) => {
      try {
        const { applicationId } = query;
        if (!applicationId) {
          set.status = 400;
          return "You must provide an applicationId";
        }

        const quotes = await db
          .select()
          .from(ApplicationPriceQuotes)
          .where(eq(ApplicationPriceQuotes.applicationId, applicationId));

        return quotes;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        applicationId: t.String(),
      }),
      detail: {
        summary: "Get Application Price Quotes by applicationId",
        description: `Returns all price quotes for the specified applicationId`,
        tags: [TAG.APPLICATIONS],
      },
    }
  );

export type PublicApplicationsRoutes = typeof publicApplicationsRoutes;
