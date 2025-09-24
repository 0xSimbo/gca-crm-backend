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
import { forwarderAddresses } from "../../constants/addresses";
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
  Documents,
  zones,
  fractions,
} from "../../db/schema";
import { eq, inArray, and, asc, desc, exists, sql, gt, ne } from "drizzle-orm";
import { completeApplicationWithDocumentsAndCreateFarmWithDevices } from "../../db/mutations/applications/completeApplicationWithDocumentsAndCreateFarm";
import { getPubkeysAndShortIds } from "../devices/get-pubkeys-and-short-ids";
import { findAllAuditFeesPaidApplicationsByZoneId } from "../../db/queries/applications/findAllAuditFeesPaidApplicationsByZoneId";
import {
  DECIMALS_BY_TOKEN,
  PAYMENT_CURRENCIES,
  TRANSFER_TYPES,
} from "@glowlabs-org/utils/browser";
import { getUniqueStarNameForApplicationId } from "../farms/farmsRouter";
import {
  findFractionById,
  findActiveFractionByApplicationId,
} from "../../db/queries/fractions/findFractionsByApplicationId";
import { markFractionAsFilled } from "../../db/mutations/fractions/createFraction";
import { getFractionEventService } from "../../services/eventListener";

/**
 * Helper function to complete an application and create a farm with devices
 * This is shared between direct payment and fraction-based payment flows
 */
export async function completeApplicationAndCreateFarm({
  application,
  txHash,
  paymentDate,
  paymentCurrency,
  paymentEventType,
  paymentAmount,
  protocolFee,
  protocolFeeAdditionalPaymentTxHash = null,
  payer,
}: {
  application: any;
  txHash: string;
  paymentDate: Date;
  paymentCurrency: (typeof PAYMENT_CURRENCIES)[number];
  paymentEventType: string;
  paymentAmount: string;
  protocolFee: bigint;
  protocolFeeAdditionalPaymentTxHash?: string | null;
  payer: string;
}) {
  if (application.status === ApplicationStatusEnum.completed) {
    throw new Error("Application is already completed");
  }

  // Get unique farm name
  const farmName = await getUniqueStarNameForApplicationId(application.id);
  if (!farmName) {
    throw new Error("Failed to get a unique farm name");
  }

  // Create farm
  const farmId = await completeApplicationWithDocumentsAndCreateFarmWithDevices(
    {
      protocolFeePaymentHash: txHash,
      paymentDate,
      paymentCurrency,
      paymentEventType,
      paymentAmount,
      applicationId: application.id,
      gcaId: application.gcaAddress || application.gca?.id,
      userId: application.userId || application.user?.id,
      devices: application.auditFields?.devices || [],
      protocolFee,
      protocolFeeAdditionalPaymentTxHash,
      lat: application.enquiryFields?.lat || "0",
      lng: application.enquiryFields?.lng || "0",
      farmName,
      payer,
    }
  );

  // Trigger hub solar farms sync after 20 seconds delay
  setTimeout(async () => {
    try {
      await fetch(
        `${process.env.CONTROL_API_URL}/hub-solar-farms-sync-trigger`
      );
    } catch (error) {
      console.error("Failed to trigger hub solar farms sync:", error);
    }
  }, 20000); // 20 seconds delay

  // Emit event in production
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
          applicationId: application.id,
          payer,
          amount_6Decimals: paymentAmount,
          txHash,
          paymentCurrency,
          paymentEventType,
          isSponsored: false,
        },
      })
      .catch((e) => {
        console.error("error with audit.pfees.paid event", e);
      });
  }

  return farmId;
}

export const publicApplicationsRoutes = new Elysia()
  .get(
    "/sponsor-listings-applications",
    async ({ query, set }) => {
      try {
        const { zoneId, sortBy, sortOrder, paymentCurrency } = query;

        // Parse zoneId if provided
        const parsedZoneId = zoneId !== undefined ? Number(zoneId) : undefined;
        if (zoneId !== undefined && Number.isNaN(parsedZoneId)) {
          set.status = 400;
          return "zoneId must be a valid number if provided";
        }

        // Build where conditions
        const baseConditions = [
          eq(applications.status, ApplicationStatusEnum.waitingForPayment),
        ];

        // Add zoneId filter if specified
        if (parsedZoneId !== undefined) {
          baseConditions.push(eq(applications.zoneId, parsedZoneId));
        }

        // Add zone filter for accepting sponsors - join with zones table
        baseConditions.push(
          exists(
            db
              .select()
              .from(zones)
              .where(
                and(
                  eq(zones.id, applications.zoneId),
                  eq(zones.isAcceptingSponsors, true)
                )
              )
          )
        );

        // Add filter to only show applications that have active fractions
        baseConditions.push(
          exists(
            db
              .select()
              .from(fractions)
              .where(
                and(
                  eq(fractions.applicationId, applications.id),
                  inArray(fractions.status, ["draft", "committed"]),
                  gt(fractions.expirationAt, new Date()),
                  ne(fractions.type, "mining-center")
                )
              )
          )
        );

        const whereConditions = and(...baseConditions);

        // Note: Payment currency filtering and sorting are done in JavaScript after the query
        // due to complexities with JSON column querying in SQL and cross-table sorting

        const auctionApplications = await db.query.applications.findMany({
          where: whereConditions,
          // Remove orderBy from the main query since it's causing issues with joins
          // We'll sort in JavaScript after the query
          columns: {
            id: true,
            userId: true,
            zoneId: true,
            status: true,
            createdAt: true,
            finalProtocolFee: true,
            paymentCurrency: true,
            paymentEventType: true,
          },
          with: {
            zone: {
              columns: {
                id: true,
                name: true,
                isAcceptingSponsors: true,
                isActive: true,
              },
              with: {
                requirementSet: {
                  columns: {
                    id: true,
                    name: true,
                    code: true,
                  },
                },
              },
            },
            applicationPriceQuotes: {
              columns: {
                id: true,
                prices: true,
                signature: true,
                createdAt: true,
                gcaAddress: true,
              },
              orderBy: desc(ApplicationPriceQuotes.createdAt),
            },
            enquiryFieldsCRS: {
              columns: {
                address: true,
                lat: true,
                lng: true,
                estimatedKWhGeneratedPerYear: true,
              },
            },
            auditFieldsCRS: {
              columns: {
                systemWattageOutput: true,
                averageSunlightHoursPerDay: true,
                adjustedWeeklyCarbonCredits: true,
              },
            },
            weeklyProduction: true,
            weeklyCarbonDebt: true,
            documents: {
              where: and(
                eq(Documents.isEncrypted, false),
                eq(Documents.isShowingSolarPanels, true)
              ),
              columns: {
                id: true,
                name: true,
                url: true,
              },
            },
            fractions: {
              where: and(
                inArray(fractions.status, ["draft", "committed"]),
                gt(fractions.expirationAt, new Date())
              ),
              columns: {
                id: true,
                nonce: true,
                status: true,
                sponsorSplitPercent: true,
                createdAt: true,
                expirationAt: true,
                isCommittedOnChain: true,
                isFilled: true,
                rewardScore: true,
                totalSteps: true,
                splitsSold: true,
                step: true,
                token: true,
                owner: true,
                txHash: true,
              },
              orderBy: desc(fractions.createdAt),
              limit: 1, // Get only the latest active fraction
            },
          },
        });

        // Filter by payment currency in JavaScript if specified
        let filteredApplications = auctionApplications;
        if (paymentCurrency) {
          filteredApplications = auctionApplications.filter((app) => {
            return app.applicationPriceQuotes.some(
              (quote) =>
                quote.prices &&
                quote.prices[paymentCurrency] &&
                Number(quote.prices[paymentCurrency]) > 0
            );
          });
        }

        // Filter out applications without active fractions (double-check SQL filtering)
        filteredApplications = filteredApplications.filter((app) => {
          return app.fractions && app.fractions.length > 0;
        });

        // Apply sorting in JavaScript since SQL orderBy was causing issues with joins
        if (sortBy && filteredApplications.length > 0) {
          const sortMultiplier = sortOrder === "desc" ? -1 : 1;

          filteredApplications.sort((a, b) => {
            let aValue: any;
            let bValue: any;

            switch (sortBy) {
              case "sponsorSplitPercent":
                aValue = a.fractions?.[0]?.sponsorSplitPercent || 0;
                bValue = b.fractions?.[0]?.sponsorSplitPercent || 0;
                break;
              case "finalProtocolFee":
                aValue = Number(a.finalProtocolFee || 0);
                bValue = Number(b.finalProtocolFee || 0);
                break;
              case "paymentCurrency":
                if (paymentCurrency) {
                  // Sort by the price of the specific currency
                  const aQuote = a.applicationPriceQuotes.find(
                    (q) =>
                      q.prices &&
                      q.prices[paymentCurrency] &&
                      Number(q.prices[paymentCurrency]) > 0
                  );
                  const bQuote = b.applicationPriceQuotes.find(
                    (q) =>
                      q.prices &&
                      q.prices[paymentCurrency] &&
                      Number(q.prices[paymentCurrency]) > 0
                  );
                  aValue = aQuote
                    ? Number(aQuote.prices[paymentCurrency])
                    : Infinity;
                  bValue = bQuote
                    ? Number(bQuote.prices[paymentCurrency])
                    : Infinity;
                } else {
                  // Sort by number of available currencies
                  aValue = a.applicationPriceQuotes.reduce((count, quote) => {
                    return (
                      count +
                      (quote.prices ? Object.keys(quote.prices).length : 0)
                    );
                  }, 0);
                  bValue = b.applicationPriceQuotes.reduce((count, quote) => {
                    return (
                      count +
                      (quote.prices ? Object.keys(quote.prices).length : 0)
                    );
                  }, 0);
                }
                break;
              default:
                // Default sort by fraction creation date
                aValue = a.fractions?.[0]?.createdAt
                  ? new Date(a.fractions[0].createdAt).getTime()
                  : 0;
                bValue = b.fractions?.[0]?.createdAt
                  ? new Date(b.fractions[0].createdAt).getTime()
                  : 0;
                break;
            }

            if (aValue < bValue) return -1 * sortMultiplier;
            if (aValue > bValue) return 1 * sortMultiplier;
            return 0;
          });
        }

        return filteredApplications.map((app) => {
          // Get the active fraction directly from the query result
          const activeFraction =
            app.fractions && app.fractions.length > 0 ? app.fractions[0] : null;

          return {
            id: app.id,
            userId: app.userId,
            status: app.status,
            createdAt: app.createdAt,
            // Use fraction data instead of application fields
            isPublishedOnAuction: !!activeFraction, // Has fraction = published on auction
            publishedOnAuctionTimestamp: activeFraction?.createdAt || null,
            sponsorSplitPercent: activeFraction?.sponsorSplitPercent || null,
            finalProtocolFee: app.finalProtocolFee?.toString(),
            paymentCurrency: app.paymentCurrency,
            paymentEventType: app.paymentEventType,
            zone: app.zone,
            applicationPriceQuotes: app.applicationPriceQuotes,
            enquiryFields: app.enquiryFieldsCRS,
            auditFields: app.auditFieldsCRS,
            weeklyProduction: app.weeklyProduction,
            weeklyCarbonDebt: app.weeklyCarbonDebt,
            afterInstallPictures: app.documents.filter((d) =>
              d.name.includes("after_install_pictures")
            ),
            // Add active fraction information
            activeFraction: activeFraction
              ? {
                  id: activeFraction.id,
                  nonce: activeFraction.nonce,
                  status: activeFraction.status,
                  sponsorSplitPercent: activeFraction.sponsorSplitPercent,
                  createdAt: activeFraction.createdAt,
                  expirationAt: activeFraction.expirationAt,
                  isCommittedOnChain: activeFraction.isCommittedOnChain,
                  isFilled: activeFraction.isFilled,
                  totalSteps: activeFraction.totalSteps,
                  splitsSold: activeFraction.splitsSold,
                  step: activeFraction.step, // Price per step in token decimals
                  token: activeFraction.token,
                  owner: activeFraction.owner,
                  txHash: activeFraction.txHash,
                  rewardScore: activeFraction.rewardScore,
                  // Calculate progress percentage
                  progressPercent:
                    activeFraction.totalSteps && activeFraction.splitsSold
                      ? Math.round(
                          (activeFraction.splitsSold /
                            activeFraction.totalSteps) *
                            100
                        )
                      : 0,
                  // Calculate remaining splits
                  remainingSteps: activeFraction.totalSteps
                    ? activeFraction.totalSteps -
                      (activeFraction.splitsSold || 0)
                    : null,
                  // Calculate total amount raised so far (step * splitsSold)
                  amountRaised:
                    activeFraction.step && activeFraction.splitsSold
                      ? (
                          BigInt(activeFraction.step) *
                          BigInt(activeFraction.splitsSold)
                        ).toString()
                      : null,
                  // Calculate total amount needed (step * totalSteps)
                  totalAmountNeeded:
                    activeFraction.step && activeFraction.totalSteps
                      ? (
                          BigInt(activeFraction.step) *
                          BigInt(activeFraction.totalSteps)
                        ).toString()
                      : null,
                }
              : null,
          };
        });
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
        zoneId: t.Optional(t.Numeric()),
        sortBy: t.Optional(
          t.Union([
            t.Literal("publishedOnAuctionTimestamp"),
            t.Literal("sponsorSplitPercent"),
            t.Literal("finalProtocolFee"),
            t.Literal("paymentCurrency"),
          ])
        ),
        paymentCurrency: t.Optional(
          t.Union([
            t.Literal("USDG"),
            t.Literal("USDC"),
            t.Literal("GLW"),
            t.Literal("GCTL"),
          ])
        ),
        sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
      }),
      detail: {
        summary: "Get auction applications available for sponsorship",
        description: `Returns applications that are waiting for payment, published on auction, in zones accepting sponsors, and have active fractions available for purchase. Only applications with active fractions (draft or committed status, not expired) are returned. Supports filtering by zoneId and paymentCurrency, and sorting by publishedOnAuctionTimestamp, sponsorSplitPercent, finalProtocolFee, or paymentCurrency. When sorting by paymentCurrency with a specific currency filter, sorts by lowest price for that currency. Includes application price quotes, related data, and active fraction information showing funding progress, steps sold, amounts raised, and expiration details.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/audit-fees-paid",
    async ({ query, set }) => {
      try {
        const { zoneId } = query;
        const parsed = zoneId !== undefined ? Number(zoneId) : undefined;
        if (zoneId !== undefined && Number.isNaN(parsed)) {
          set.status = 400;
          return "zoneId must be a valid number if provided";
        }

        const applications = await findAllAuditFeesPaidApplicationsByZoneId(
          parsed
        );
        return applications;
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
      query: t.Object({ zoneId: t.Optional(t.Numeric()) }),
      detail: {
        summary: "Get applications with paid audit fees by zoneId",
        description:
          "Returns all applications with paid audit fees (auditFeesTxHash set). If zoneId is provided, results are filtered by that zone.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
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

        const applicationId = body.applicationId;

        const application = await FindFirstApplicationById(applicationId);

        if (!application) {
          set.status = 404;
          return `Application not found: ${applicationId}`;
        }

        const isZoneActive = await db.query.zones.findFirst({
          where: eq(zones.id, application.zoneId),
        });

        if (!isZoneActive) {
          set.status = 400;
          return "Zone is not active";
        }

        if (application.status !== ApplicationStatusEnum.waitingForPayment) {
          set.status = 400;
          return "Application is not waiting for payment";
        }

        // CRITICAL: Check if there's an active fraction for this application
        const activeFraction = await findActiveFractionByApplicationId(
          application.id
        );
        if (activeFraction) {
          set.status = 400;
          return `Cannot finalize direct payment: application has an active fraction (${activeFraction.id}) that must be completed through the fraction system instead`;
        }

        if (BigInt(application.finalProtocolFeeBigInt) === BigInt(0)) {
          console.error("Final Protocol Fee is not set");
          set.status = 400;
          return "Final Protocol Fee is not set";
        }

        const currency = body.paymentCurrency;

        if (!(currency in DECIMALS_BY_TOKEN)) {
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

        const pricePerTokenScaled6 =
          currency === "SGCTL" ? prices["GCTL"] : prices[currency];

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

        if (BigInt(body.amount) === BigInt(0)) {
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

        const farmId = await completeApplicationAndCreateFarm({
          application,
          txHash: body.txHash,
          paymentDate: body.paymentDate,
          paymentCurrency: body.paymentCurrency,
          paymentEventType: body.eventType,
          paymentAmount: body.amount,
          protocolFee: BigInt(application.finalProtocolFeeBigInt),
          protocolFeeAdditionalPaymentTxHash: null,
          payer: body.from,
        });

        return { farmId };
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
        applicationId: t.String(),
        paymentCurrency: t.Enum(
          Object.fromEntries(PAYMENT_CURRENCIES.map((c) => [c, c])),
          { type: "string" }
        ),
        eventType: t.String(),
        amount: t.String(),
        paymentDate: t.Date(),
        from: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
      }),
      detail: {
        summary: "Finalize Payment",
        description: `Finalize direct payment for applications without active fractions. If an application has an active fraction, payment must go through the fraction system instead. Updates the application status to paymentConfirmed and creates the farm.`,
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

        if (
          forwarderData.to.toLowerCase() !==
          forwarderAddresses.AUDIT_FEE_WALLET.toLowerCase()
        ) {
          set.status = 400;
          return `Invalid audit fees wallet address: ${forwarderData.to} (expected: ${forwarderAddresses.AUDIT_FEE_WALLET})`;
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
            zoneId: 2,
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
            estimatedAdjustedWeeklyCredits: "0.12",
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

          const allAfterInstallDocummentsToCopy = await tx
            .select()
            .from(Documents)
            .where(
              and(
                eq(
                  Documents.applicationId,
                  "739dd541-0a06-4853-9eae-224f0f2e51cf"
                ),
                eq(Documents.step, 5)
              )
            );

          if (allAfterInstallDocummentsToCopy.length > 0) {
            await tx.insert(Documents).values(
              allAfterInstallDocummentsToCopy.map((d) => ({
                ...d,
                id: crypto.randomUUID(),
                applicationId: applicationDraft.id,
                createdAt: new Date(),
                step: 5,
              }))
            );
          }

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

          await tx.insert(RewardSplits).values([
            {
              walletAddress: "0x34b50C3A7f004c65CEF59aa29cC9102C46d4c9bA",
              glowSplitPercent: "50",
              usdgSplitPercent: "10",
              applicationId: applicationDraft.id,
            },
            {
              walletAddress: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70c8",
              glowSplitPercent: "40",
              usdgSplitPercent: "90",
              applicationId: applicationDraft.id,
            },
            {
              walletAddress: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
              glowSplitPercent: "10",
              usdgSplitPercent: "0",
              applicationId: applicationDraft.id,
            },
          ]);

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
