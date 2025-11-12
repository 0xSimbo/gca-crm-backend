import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { allRegions } from "@glowlabs-org/utils/browser";
import { extractElectricityPriceFromUtilityBill } from "./helpers/extractElectricityPrice";
import { computeNonAccountQuote } from "./helpers/computeNonAccountQuote";
import { createNonAccountQuote } from "../../db/mutations/non-account-quotes/createNonAccountQuote";
import { findNonAccountQuoteById } from "../../db/queries/non-account-quotes/findNonAccountQuoteById";
import { getRegionCodeFromCoordinates } from "./helpers/mapStateToRegionCode";

export const nonAccountQuoteRoutes = new Elysia({ prefix: "/non-account" })
  .get(
    "/regions",
    async () => {
      return { regions: allRegions };
    },
    {
      detail: {
        summary: "Get available regions for non-account quotes",
        description:
          "Returns a list of all available regions from the SDK regionMetadata. Note: Region selection is now automatic based on coordinates, but this endpoint remains available for reference.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/quote",
    async ({ body, set }) => {
      try {
        const allowMock = process.env.NODE_ENV === "staging";
        const skipDb =
          process.env.NODE_ENV === "test" ||
          process.env.NON_ACCOUNT_QUOTE_SKIP_DB === "true";

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
            file.type
          );
          priceExtraction = extracted.result;
          billUrl = extracted.billUrl;
        }

        // Compute quote
        const quoteResult = await computeNonAccountQuote({
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
            }
          : await createNonAccountQuote({
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
          console.error("[nonAccountQuoteRoutes] /quote error:", e);
          set.status = 400;
          return { error: e.message };
        }
        console.error("[nonAccountQuoteRoutes] /quote unknown error:", e);
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
          description: "Utility bill image or PDF for price extraction",
        }),
        // test-only optional overrides (used only when NODE_ENV=test or NON_ACCOUNT_QUOTE_ALLOW_MOCK=true)
        mockElectricityPricePerKwh: t.Optional(t.String()),
        mockDiscountRate: t.Optional(t.String()),
        mockEscalatorRate: t.Optional(t.String()),
        mockYears: t.Optional(t.String()),
        mockCarbonOffsetsPerMwh: t.Optional(t.String()),
      }),
      detail: {
        summary: "Request a non-account quote for protocol deposit estimation",
        description:
          "Upload a utility bill, provide Aurora weekly consumption, system size, and location coordinates. The region will be automatically determined from the coordinates. Returns estimated protocol deposit in USD (6 decimals), weekly carbon credits and debt, net carbon credits per MWh, efficiency score, and extraction details. The quote is persisted with a unique ID for later retrieval.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/quote/:id",
    async ({ params, set }) => {
      try {
        const quote = await findNonAccountQuoteById(params.id);

        if (!quote) {
          set.status = 404;
          return { error: "Quote not found" };
        }

        // Return formatted quote
        return {
          quoteId: quote.id,
          createdAt: quote.createdAt,
          regionCode: quote.regionCode,
          location: {
            latitude: parseFloat(quote.latitude),
            longitude: parseFloat(quote.longitude),
          },
          inputs: {
            weeklyConsumptionMWh: parseFloat(quote.weeklyConsumptionMWh),
            systemSizeKw: parseFloat(quote.systemSizeKw),
          },
          protocolDeposit: {
            usd6Decimals: quote.protocolDepositUsd6,
            usd: parseFloat(quote.protocolDepositUsd6) / 1e6,
          },
          carbonMetrics: {
            weeklyCredits: parseFloat(quote.weeklyCredits),
            weeklyDebt: parseFloat(quote.weeklyDebt),
            netWeeklyCc: parseFloat(quote.netWeeklyCc),
            netCcPerMwh: parseFloat(quote.netCcPerMwh),
            carbonOffsetsPerMwh: parseFloat(quote.carbonOffsetsPerMwh),
            uncertaintyApplied: parseFloat(quote.uncertaintyApplied),
          },
          efficiency: {
            score: quote.efficiencyScore,
            weeklyImpactAssetsWad: quote.weeklyImpactAssetsWad,
          },
          rates: {
            discountRate: parseFloat(quote.discountRate),
            escalatorRate: parseFloat(quote.escalatorRate),
            commitmentYears: quote.years,
          },
          extraction: {
            electricityPricePerKwh: parseFloat(quote.electricityPricePerKwh),
            confidence: quote.priceConfidence
              ? parseFloat(quote.priceConfidence)
              : null,
            source: quote.priceSource,
            utilityBillUrl: quote.utilityBillUrl,
          },
          admin: {
            cashAmountUsd: quote.cashAmountUsd,
          },
          debug: quote.debugJson,
        };
      } catch (e) {
        if (e instanceof Error) {
          console.error("[nonAccountQuoteRoutes] /quote/:id error:", e);
          set.status = 400;
          return { error: e.message };
        }
        console.error("[nonAccountQuoteRoutes] /quote/:id unknown error:", e);
        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      params: t.Object({
        id: t.String({ description: "Quote ID" }),
      }),
      detail: {
        summary: "Retrieve a previously computed non-account quote by ID",
        description:
          "Returns the full quote details including protocol deposit estimate, carbon metrics, efficiency score, and extraction information.",
        tags: [TAG.APPLICATIONS],
      },
    }
  );

export type NonAccountQuoteRoutes = typeof nonAccountQuoteRoutes;
