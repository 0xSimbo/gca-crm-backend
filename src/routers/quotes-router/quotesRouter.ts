import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { allRegions } from "@glowlabs-org/utils/browser";
import { extractElectricityPriceFromUtilityBill } from "../applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "../applications-router/helpers/computeProjectQuote";
import { createProjectQuote } from "../../db/mutations/project-quotes/createProjectQuote";
import { findProjectQuoteById } from "../../db/queries/project-quotes/findProjectQuoteById";
import { findProjectQuotesByWalletAddress } from "../../db/queries/project-quotes/findProjectQuotesByWalletAddress";
import { countQuotesInLastHour } from "../../db/queries/project-quotes/countQuotesInLastHour";
import { getRegionCodeFromCoordinates } from "../applications-router/helpers/mapStateToRegionCode";
import {
  verifyQuoteSignature,
  validateTimestamp,
  createMessageToSign,
  verifyBatchSignature,
} from "../../handlers/walletSignatureHandler";
import { mapWalletToUserId } from "../../utils/mapWalletToUserId";
import pLimit from "p-limit";
import { createProjectQuoteBatch } from "../../db/mutations/project-quote-batches/createProjectQuoteBatch";
import { updateProjectQuoteBatch } from "../../db/mutations/project-quote-batches/updateProjectQuoteBatch";
import { incrementProjectQuoteBatchProgress } from "../../db/mutations/project-quote-batches/incrementProjectQuoteBatchProgress";
import { findProjectQuoteBatchById } from "../../db/queries/project-quote-batches/findProjectQuoteBatchById";
import { countProjectQuoteBatchItemsInLastHour } from "../../db/queries/project-quote-batches/countProjectQuoteBatchItemsInLastHour";

interface QuoteProjectRequest {
  weeklyConsumptionMWh: string;
  systemSizeKw: string;
  latitude: string;
  longitude: string;
  timestamp: string;
  signature: string;
  metadata?: string;
  isProjectCompleted?: boolean;
  mockElectricityPricePerKwh?: string;
  mockDiscountRate?: string;
  mockEscalatorRate?: string;
  mockYears?: string;
  mockCarbonOffsetsPerMwh?: string;
}

const quoteProjectRequestSchema = t.Object({
  weeklyConsumptionMWh: t.String({
    description: "Weekly energy consumption in MWh (from Aurora)",
  }),
  systemSizeKw: t.String({
    description: "System size in kW (nameplate capacity)",
  }),
  latitude: t.String({
    description: "Latitude of the solar farm location",
  }),
  longitude: t.String({
    description: "Longitude of the solar farm location",
  }),
  timestamp: t.String({
    description: "Unix timestamp in milliseconds when signature was created",
  }),
  signature: t.String({
    description:
      "Wallet signature of message: weeklyConsumptionMWh,systemSizeKw,latitude,longitude,timestamp",
    minLength: 132,
    maxLength: 132,
  }),
  metadata: t.Optional(
    t.String({
      description:
        "Optional metadata for identifying the quote (e.g., farm owner name, project ID)",
    })
  ),
  isProjectCompleted: t.Optional(
    t.Boolean({
      description:
        "Optional flag indicating if the solar project is already live/completed",
    })
  ),
  // Test-only optional overrides (staging only)
  mockElectricityPricePerKwh: t.Optional(t.String()),
  mockDiscountRate: t.Optional(t.String()),
  mockEscalatorRate: t.Optional(t.String()),
  mockYears: t.Optional(t.String()),
  mockCarbonOffsetsPerMwh: t.Optional(t.String()),
});

// Cast to `any` to avoid TypeScript "type instantiation is excessively deep" errors
// while keeping runtime validation + Swagger schema.
const quoteProjectBatchBodySchema = t.Object({
  requests: t.ArrayString(quoteProjectRequestSchema, {
    minItems: 1,
    maxItems: 100,
  }),
  utilityBills: t.Files({
    description:
      "Utility bill PDFs for price extraction. Must be the same length as requests and in the same order.",
  }),
}) as any;

function parseStrictFloat(value: string, fieldName: string) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  return parsed;
}

function parseStrictInt(value: string, fieldName: string) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  return parsed;
}

async function createProjectQuoteFromRequest(args: {
  request: QuoteProjectRequest;
  utilityBill: File;
  allowMock: boolean;
  skipDb: boolean;
  validateSignatureTimestamp?: boolean;
}) {
  const {
    request,
    utilityBill,
    allowMock,
    skipDb,
    validateSignatureTimestamp = true,
  } = args;

  const timestamp = parseStrictInt(request.timestamp, "timestamp");
  if (validateSignatureTimestamp) {
    validateTimestamp(timestamp);
  }

  const weeklyConsumptionMWh = parseStrictFloat(
    request.weeklyConsumptionMWh,
    "weeklyConsumptionMWh"
  );
  if (weeklyConsumptionMWh <= 0) {
    throw new Error("weeklyConsumptionMWh must be a positive number");
  }

  const systemSizeKw = parseStrictFloat(request.systemSizeKw, "systemSizeKw");
  if (systemSizeKw <= 0) {
    throw new Error("systemSizeKw must be a positive number");
  }

  const latitude = parseStrictFloat(request.latitude, "latitude");
  const longitude = parseStrictFloat(request.longitude, "longitude");

  let walletAddress: string;
  try {
    walletAddress = verifyQuoteSignature(
      {
        weeklyConsumptionMWh: request.weeklyConsumptionMWh,
        systemSizeKw: request.systemSizeKw,
        latitude: request.latitude,
        longitude: request.longitude,
        timestamp,
      },
      request.signature
    ).toLowerCase();
  } catch (error) {
    throw new Error(
      `Invalid signature: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }

  const userId = await mapWalletToUserId(walletAddress);

  const regionCode = await getRegionCodeFromCoordinates(latitude, longitude);
  if (!regionCode) {
    throw new Error(
      "Unable to determine region from the provided coordinates. Please ensure the location is within a supported region."
    );
  }

  if (utilityBill.type !== "application/pdf") {
    throw new Error(
      "Only PDF utility bills are accepted. Please upload a PDF file."
    );
  }

  const maxSize = 10 * 1024 * 1024;
  if (utilityBill.size > maxSize) {
    throw new Error("File size must be less than 10MB");
  }

  let priceExtraction: {
    pricePerKwh: number;
    confidence: number;
    rationale: string;
  };
  let billUrl = "";

  if (allowMock && request.mockElectricityPricePerKwh) {
    priceExtraction = {
      pricePerKwh: parseStrictFloat(
        request.mockElectricityPricePerKwh,
        "mockElectricityPricePerKwh"
      ),
      confidence: 1,
      rationale: "mocked for test",
    };
    billUrl = "https://example.com/mock-bill";
  } else {
    const fileBuffer = Buffer.from(await utilityBill.arrayBuffer());
    const extracted = await extractElectricityPriceFromUtilityBill(
      fileBuffer,
      utilityBill.name,
      utilityBill.type,
      regionCode
    );
    priceExtraction = extracted.result;
    billUrl = extracted.billUrl;
  }

  const quoteResult = await computeProjectQuote({
    weeklyConsumptionMWh,
    systemSizeKw,
    electricityPricePerKwh: priceExtraction.pricePerKwh,
    latitude,
    longitude,
    override: allowMock
      ? {
          discountRate: request.mockDiscountRate
            ? parseStrictFloat(request.mockDiscountRate, "mockDiscountRate")
            : undefined,
          escalatorRate: request.mockEscalatorRate
            ? parseStrictFloat(request.mockEscalatorRate, "mockEscalatorRate")
            : undefined,
          years: request.mockYears
            ? parseStrictInt(request.mockYears, "mockYears")
            : undefined,
          carbonOffsetsPerMwh: request.mockCarbonOffsetsPerMwh
            ? parseStrictFloat(
                request.mockCarbonOffsetsPerMwh,
                "mockCarbonOffsetsPerMwh"
              )
            : undefined,
        }
      : undefined,
  });

  const savedQuote = skipDb
    ? {
        id: "test-quote-id",
        regionCode,
        walletAddress,
        userId,
        metadata: request.metadata || null,
        isProjectCompleted: request.isProjectCompleted ?? false,
      }
    : await createProjectQuote({
        walletAddress,
        userId,
        metadata: request.metadata,
        isProjectCompleted: request.isProjectCompleted ?? false,
        regionCode,
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        weeklyConsumptionMWh: weeklyConsumptionMWh.toString(),
        systemSizeKw: systemSizeKw.toString(),
        electricityPricePerKwh: priceExtraction.pricePerKwh.toString(),
        priceSource: "ai",
        priceConfidence: priceExtraction.confidence.toString(),
        utilityBillUrl: billUrl,
        discountRate: quoteResult.discountRate.toString(),
        escalatorRate: quoteResult.escalatorRate.toString(),
        years: quoteResult.years,
        protocolDepositUsd6: quoteResult.protocolDepositUsd6,
        weeklyCredits: quoteResult.weeklyCredits.toString(),
        weeklyDebt: quoteResult.weeklyDebt.toString(),
        netWeeklyCc: quoteResult.netWeeklyCc.toString(),
        netCcPerMwh: quoteResult.netCcPerMwh.toString(),
        weeklyImpactAssetsWad: quoteResult.weeklyImpactAssetsWad,
        efficiencyScore: quoteResult.efficiencyScore,
        carbonOffsetsPerMwh: quoteResult.carbonOffsetsPerMwh.toString(),
        uncertaintyApplied: quoteResult.uncertaintyApplied.toString(),
        debugJson: quoteResult.debugJson,
      });

  return {
    quoteId: savedQuote.id,
    walletAddress: savedQuote.walletAddress,
    userId: savedQuote.userId,
    metadata: savedQuote.metadata,
    isProjectCompleted: savedQuote.isProjectCompleted,
    regionCode: savedQuote.regionCode,
    protocolDeposit: {
      usd: quoteResult.protocolDepositUsd,
      usd6Decimals: quoteResult.protocolDepositUsd6,
    },
    carbonMetrics: {
      weeklyCredits: quoteResult.weeklyCredits,
      weeklyDebt: quoteResult.weeklyDebt,
      netWeeklyCc: quoteResult.netWeeklyCc,
      netCcPerMwh: quoteResult.netCcPerMwh,
      carbonOffsetsPerMwh: quoteResult.carbonOffsetsPerMwh,
      uncertaintyApplied: quoteResult.uncertaintyApplied,
    },
    efficiency: {
      score: quoteResult.efficiencyScore,
      weeklyImpactAssetsWad: quoteResult.weeklyImpactAssetsWad,
    },
    rates: {
      discountRate: quoteResult.discountRate,
      escalatorRate: quoteResult.escalatorRate,
      commitmentYears: quoteResult.years,
    },
    extraction: {
      electricityPricePerKwh: priceExtraction.pricePerKwh,
      confidence: priceExtraction.confidence,
      rationale: priceExtraction.rationale,
      utilityBillUrl: billUrl,
    },
    debug: quoteResult.debugJson,
  };
}

async function processProjectQuoteBatch(args: {
  batchId: string;
  requests: QuoteProjectRequest[];
  utilityBills: File[];
  allowMock: boolean;
  skipDb: boolean;
  concurrency: number;
}) {
  const { batchId, requests, utilityBills, allowMock, skipDb, concurrency } =
    args;

  await updateProjectQuoteBatch(batchId, {
    status: "running",
    startedAt: new Date(),
    processedCount: 0,
    successCount: 0,
    errorCount: 0,
  });

  const limit = pLimit(concurrency);
  const results = await Promise.all(
    requests.map((request, index) =>
      limit(async () => {
        try {
          const data = await createProjectQuoteFromRequest({
            request,
            utilityBill: utilityBills[index]!,
            allowMock,
            skipDb,
            // Timestamp freshness already validated at submission time.
            validateSignatureTimestamp: false,
          });
          await incrementProjectQuoteBatchProgress({
            batchId,
            isSuccess: true,
          });
          return { index, success: true as const, quoteId: data.quoteId };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await incrementProjectQuoteBatchProgress({
            batchId,
            isSuccess: false,
          });
          return { index, success: false as const, error: message };
        }
      })
    )
  );

  const successCount = results.filter((r) => r.success).length;
  const errorCount = results.length - successCount;

  await updateProjectQuoteBatch(batchId, {
    status: "completed",
    completedAt: new Date(),
    processedCount: results.length,
    successCount,
    errorCount,
    results,
  });
}

export const quotesRouter = new Elysia({ prefix: "/quotes" })
  .get(
    "/regions",
    async () => {
      return { regions: allRegions };
    },
    {
      detail: {
        summary: "Get available regions for project quotes",
        description:
          "Returns a list of all available regions from the SDK regionMetadata. Note: Region selection is now automatic based on coordinates.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/project/batch",
    async ({ body, set }: { body: any; set: any }) => {
      try {
        const allowMock = process.env.NODE_ENV === "staging";
        const skipDb =
          process.env.NODE_ENV === "test" ||
          process.env.PROJECT_QUOTE_SKIP_DB === "true";

        const requests = body.requests as QuoteProjectRequest[];
        const utilityBills = body.utilityBills as File[];

        if (!requests.length) {
          set.status = 400;
          return { error: "requests must contain at least 1 item" };
        }

        if (utilityBills.length !== requests.length) {
          set.status = 400;
          return {
            error: `utilityBills length (${utilityBills.length}) must match requests length (${requests.length})`,
          };
        }

        // Rate limit is per-item, not per-request: max 100 batch applications per hour globally.
        const batchItemCount = await countProjectQuoteBatchItemsInLastHour();
        if (batchItemCount + requests.length > 100) {
          set.status = 429;
          return {
            error: `Rate limit exceeded. The system can accept a maximum of 100 batch quote items per hour total. Already accepted: ${batchItemCount}. Requested: ${requests.length}.`,
          };
        }

        const concurrency = Math.max(
          1,
          parseStrictInt(
            process.env.PROJECT_QUOTE_BATCH_CONCURRENCY ?? "3",
            "PROJECT_QUOTE_BATCH_CONCURRENCY"
          )
        );

        // Validate signatures quickly and enforce batch ownership (one wallet per batch)
        let batchWalletAddress: string | null = null;
        for (const request of requests) {
          const timestamp = parseStrictInt(request.timestamp, "timestamp");
          validateTimestamp(timestamp);
          let recovered: string;
          try {
            recovered = verifyQuoteSignature(
              {
                weeklyConsumptionMWh: request.weeklyConsumptionMWh,
                systemSizeKw: request.systemSizeKw,
                latitude: request.latitude,
                longitude: request.longitude,
                timestamp,
              },
              request.signature
            ).toLowerCase();
          } catch (error) {
            set.status = 401;
            return {
              error: `Invalid signature: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            };
          }

          if (!batchWalletAddress) {
            batchWalletAddress = recovered;
          } else if (batchWalletAddress !== recovered) {
            set.status = 400;
            return {
              error:
                "All batch items must be signed by the same wallet address.",
            };
          }
        }

        // Validate files without reading them into memory
        const maxSize = 10 * 1024 * 1024;
        for (const file of utilityBills) {
          if (file.type !== "application/pdf") {
            set.status = 400;
            return {
              error:
                "Only PDF utility bills are accepted. Please upload PDF files.",
            };
          }
          if (file.size > maxSize) {
            set.status = 400;
            return { error: "File size must be less than 10MB" };
          }
        }

        const etaSeconds =
          Math.ceil(requests.length / Math.max(1, concurrency)) * 30;

        const created = await createProjectQuoteBatch({
          walletAddress: batchWalletAddress!,
          itemCount: requests.length,
          etaSeconds,
          status: "queued",
        });

        // Fire-and-forget background processing (in-process worker).
        queueMicrotask(() => {
          processProjectQuoteBatch({
            batchId: created.id,
            requests,
            utilityBills,
            allowMock,
            skipDb,
            concurrency,
          }).catch(async (error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            await updateProjectQuoteBatch(created.id, {
              status: "failed",
              completedAt: new Date(),
              error: message,
            });
          });
        });

        set.status = 202;
        return {
          batchId: created.id,
          etaSeconds,
          statusEndpoint: `/quotes/project/batch/${created.id}`,
        };
      } catch (e) {
        if (e instanceof Error) {
          console.error("[quotesRouter] /project/batch error:", e);
          set.status = 400;
          return { error: e.message };
        }
        console.error("[quotesRouter] /project/batch unknown error:", e);
        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      body: quoteProjectBatchBodySchema,
      detail: {
        summary:
          "Create project quotes in batch (async, wallet signature auth)",
        description:
          "Submit multiple quote requests in one call. Returns a batchId immediately; use the batch status endpoint to retrieve results later. Rate limit is 100 batch quote items per hour globally (counted per item).",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/project/batch/:batchId",
    async ({ params, query, set }: { params: any; query: any; set: any }) => {
      try {
        const batchId = params.batchId as string;
        const timestamp = parseStrictInt(query.timestamp, "timestamp");
        validateTimestamp(timestamp);

        const batch = await findProjectQuoteBatchById(batchId);
        if (!batch) {
          set.status = 404;
          return { error: "Batch not found" };
        }

        const recovered = verifyBatchSignature(
          batchId,
          timestamp,
          query.signature
        ).toLowerCase();
        if (recovered !== batch.walletAddress.toLowerCase()) {
          set.status = 403;
          return { error: "Access denied" };
        }

        return {
          batchId: batch.id,
          status: batch.status,
          createdAt: batch.createdAt,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
          itemCount: batch.itemCount,
          processedCount: batch.processedCount,
          successCount: batch.successCount,
          errorCount: batch.errorCount,
          etaSeconds: batch.etaSeconds,
          error: batch.error,
          results:
            batch.status === "completed" || batch.status === "failed"
              ? batch.results
              : undefined,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      query: t.Object({
        timestamp: t.String({
          description:
            "Unix timestamp in milliseconds when signature was created",
        }),
        signature: t.String({
          description: "Wallet signature of message: {batchId},{timestamp}",
          minLength: 132,
          maxLength: 132,
        }),
      }),
      detail: {
        summary: "Get async batch status/results (wallet signature auth)",
        description:
          "Poll a previously submitted batch. Requires a signature of the message: {batchId},{timestamp}.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/project",
    async ({ body, set }) => {
      try {
        const allowMock = process.env.NODE_ENV === "staging";
        const skipDb =
          process.env.NODE_ENV === "test" ||
          process.env.PROJECT_QUOTE_SKIP_DB === "true";

        // Check global rate limit: 100 quotes per hour for all users
        const quoteCount = await countQuotesInLastHour();
        if (quoteCount >= 100) {
          set.status = 429;
          return {
            error:
              "Rate limit exceeded. The system can process a maximum of 100 quotes per hour. Please try again later.",
          };
        }

        // Validate utility bill file
        if (!body.utilityBill) {
          set.status = 400;
          return { error: "utilityBill file is required" };
        }
        try {
          return await createProjectQuoteFromRequest({
            request: body,
            utilityBill: body.utilityBill,
            allowMock,
            skipDb,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Invalid signature:")
          ) {
            set.status = 401;
            return { error: error.message };
          }
          throw error;
        }
      } catch (e) {
        if (e instanceof Error) {
          console.error("[quotesRouter] /project error:", e);
          set.status = 400;
          return { error: e.message };
        }
        console.error("[quotesRouter] /project unknown error:", e);
        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      body: t.Object({
        weeklyConsumptionMWh: t.String({
          description: "Weekly energy consumption in MWh (from Aurora)",
        }),
        systemSizeKw: t.String({
          description: "System size in kW (nameplate capacity)",
        }),
        latitude: t.String({
          description: "Latitude of the solar farm location",
        }),
        longitude: t.String({
          description: "Longitude of the solar farm location",
        }),
        utilityBill: t.File({
          description: "Utility bill PDF for price extraction",
        }),
        timestamp: t.String({
          description:
            "Unix timestamp in milliseconds when signature was created",
        }),
        signature: t.String({
          description:
            "Wallet signature of message: weeklyConsumptionMWh,systemSizeKw,latitude,longitude,timestamp",
          minLength: 132,
          maxLength: 132,
        }),
        metadata: t.Optional(
          t.String({
            description:
              "Optional metadata for identifying the quote (e.g., farm owner name, project ID)",
          })
        ),
        isProjectCompleted: t.Optional(
          t.Boolean({
            description:
              "Optional flag indicating if the solar project is already live/completed",
          })
        ),
        // Test-only optional overrides
        mockElectricityPricePerKwh: t.Optional(t.String()),
        mockDiscountRate: t.Optional(t.String()),
        mockEscalatorRate: t.Optional(t.String()),
        mockYears: t.Optional(t.String()),
        mockCarbonOffsetsPerMwh: t.Optional(t.String()),
      }),
      detail: {
        summary: "Create a project quote with wallet signature authentication",
        description:
          "Upload a utility bill, provide Aurora weekly consumption, system size, and location coordinates. Sign the message with your wallet's private key. The region will be automatically determined from coordinates. Returns estimated protocol deposit, carbon metrics, and efficiency scores.",
        tags: [TAG.APPLICATIONS],
      },
    }
  );

export type QuotesRouter = typeof quotesRouter;
