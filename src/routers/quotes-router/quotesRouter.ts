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
} from "../../handlers/walletSignatureHandler";
import { mapWalletToUserId } from "../../utils/mapWalletToUserId";

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
    "/project",
    async ({ body, set }) => {
      try {
        const allowMock = process.env.NODE_ENV === "staging";
        const skipDb =
          process.env.NODE_ENV === "test" ||
          process.env.PROJECT_QUOTE_SKIP_DB === "true";

        // Parse and validate timestamp
        const timestamp = parseInt(body.timestamp);
        if (isNaN(timestamp)) {
          set.status = 400;
          return { error: "timestamp must be a valid number" };
        }
        validateTimestamp(timestamp);

        // Validate inputs
        const weeklyConsumptionMWh = parseFloat(body.weeklyConsumptionMWh);
        const systemSizeKw = parseFloat(body.systemSizeKw);
        const latitude = parseFloat(body.latitude);
        const longitude = parseFloat(body.longitude);

        if (isNaN(weeklyConsumptionMWh) || weeklyConsumptionMWh <= 0) {
          set.status = 400;
          return { error: "weeklyConsumptionMWh must be a positive number" };
        }

        if (isNaN(systemSizeKw) || systemSizeKw <= 0) {
          set.status = 400;
          return { error: "systemSizeKw must be a positive number" };
        }

        if (isNaN(latitude) || isNaN(longitude)) {
          set.status = 400;
          return { error: "latitude and longitude must be valid numbers" };
        }

        // Verify signature and recover wallet address
        let walletAddress: string;
        try {
          walletAddress = verifyQuoteSignature(
            {
              weeklyConsumptionMWh: body.weeklyConsumptionMWh,
              systemSizeKw: body.systemSizeKw,
              latitude: body.latitude,
              longitude: body.longitude,
              timestamp: timestamp,
            },
            body.signature
          );
          walletAddress = walletAddress.toLowerCase();
        } catch (error) {
          set.status = 401;
          return {
            error: `Invalid signature: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          };
        }

        // Map wallet to userId if exists
        const userId = await mapWalletToUserId(walletAddress);

        // Check global rate limit: 100 quotes per hour for all users
        const quoteCount = await countQuotesInLastHour();
        if (quoteCount >= 100) {
          set.status = 429;
          return {
            error:
              "Rate limit exceeded. The system can process a maximum of 100 quotes per hour. Please try again later.",
          };
        }

        // Derive region code from coordinates
        const regionCode = await getRegionCodeFromCoordinates(
          latitude,
          longitude
        );
        if (!regionCode) {
          set.status = 400;
          return {
            error:
              "Unable to determine region from the provided coordinates. Please ensure the location is within a supported region.",
          };
        }

        // Validate utility bill file
        if (!body.utilityBill) {
          set.status = 400;
          return { error: "utilityBill file is required" };
        }

        const file = body.utilityBill;

        // Only accept PDFs per the extraction methodology
        if (file.type !== "application/pdf") {
          set.status = 400;
          return {
            error:
              "Only PDF utility bills are accepted. Please upload a PDF file.",
          };
        }

        // Max 10MB file size
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
          set.status = 400;
          return { error: "File size must be less than 10MB" };
        }

        // Extract electricity price from utility bill (or use mock in test mode)
        let priceExtraction: {
          pricePerKwh: number;
          confidence: number;
          rationale: string;
        };
        let billUrl: string = "";

        if (allowMock && body.mockElectricityPricePerKwh) {
          priceExtraction = {
            pricePerKwh: parseFloat(body.mockElectricityPricePerKwh),
            confidence: 1,
            rationale: "mocked for test",
          };
          billUrl = "https://example.com/mock-bill";
        } else {
          const fileBuffer = Buffer.from(await file.arrayBuffer());
          const extracted = await extractElectricityPriceFromUtilityBill(
            fileBuffer,
            file.name,
            file.type,
            regionCode
          );
          priceExtraction = extracted.result;
          billUrl = extracted.billUrl;
        }

        // Compute quote
        const quoteResult = await computeProjectQuote({
          weeklyConsumptionMWh,
          systemSizeKw,
          electricityPricePerKwh: priceExtraction.pricePerKwh,
          latitude,
          longitude,
          override: allowMock
            ? {
                discountRate: body.mockDiscountRate
                  ? parseFloat(body.mockDiscountRate)
                  : undefined,
                escalatorRate: body.mockEscalatorRate
                  ? parseFloat(body.mockEscalatorRate)
                  : undefined,
                years: body.mockYears ? parseInt(body.mockYears) : undefined,
                carbonOffsetsPerMwh: body.mockCarbonOffsetsPerMwh
                  ? parseFloat(body.mockCarbonOffsetsPerMwh)
                  : undefined,
              }
            : undefined,
        });

        // Persist to database
        const savedQuote = skipDb
          ? {
              id: "test-quote-id",
              regionCode,
              walletAddress,
              userId,
              metadata: body.metadata || null,
              isProjectCompleted: body.isProjectCompleted ?? false,
            }
          : await createProjectQuote({
              walletAddress,
              userId,
              metadata: body.metadata,
              isProjectCompleted: body.isProjectCompleted ?? false,
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

        // Return response
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
