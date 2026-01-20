import { db } from "../src/db/db";
import { ProjectQuotes } from "../src/db/schema";
import { computeProjectQuote } from "../src/routers/applications-router/helpers/computeProjectQuote";
import { eq, or } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = process.argv.find((arg) => arg.startsWith("--limit="));
const MAX_QUOTES = LIMIT ? parseInt(LIMIT.split("=")[1]!, 10) : Infinity;
const ID_ARG = process.argv.find((arg) => arg.startsWith("--id="));
const SPECIFIC_ID = ID_ARG ? ID_ARG.split("=")[1] : null;

const LEBANON_REGION_CODE = "LB";
const LEBANON_UTILITY_BILL_URL_SENTINEL = "lebanon-fixed-rate";
const NEW_ESCALATOR_RATE = 0.05;

interface QuoteUpdateResult {
  id: string;
  success: boolean;
  oldEscalator?: number;
  newEscalator?: number;
  oldDepositUsd?: number;
  newDepositUsd?: number;
  oldEfficiency?: number;
  newEfficiency?: number;
  error?: string;
}

async function rerunLebanonEscalator() {
  console.log("=== Rerun Lebanon Quotes (Escalator Update) ===");
  if (DRY_RUN) {
    console.log("🔍 DRY RUN MODE - No changes will be saved\n");
  } else {
    console.log("⚠️  LIVE MODE - Changes will be saved to database\n");
  }

  let quotes;
  if (SPECIFIC_ID) {
    console.log(`Fetching specific quote: ${SPECIFIC_ID}\n`);
    const quote = await db.query.ProjectQuotes.findFirst({
      where: eq(ProjectQuotes.id, SPECIFIC_ID),
    });
    if (!quote) {
      console.error(`Quote not found: ${SPECIFIC_ID}`);
      process.exit(1);
    }
    quotes = [quote];
  } else {
    quotes = await db.query.ProjectQuotes.findMany({
      where: or(
        eq(ProjectQuotes.regionCode, LEBANON_REGION_CODE),
        eq(ProjectQuotes.utilityBillUrl, LEBANON_UTILITY_BILL_URL_SENTINEL)
      ),
      orderBy: (q, { desc }) => [desc(q.createdAt)],
    });

    if (MAX_QUOTES < quotes.length) {
      console.log(
        `Limiting to first ${MAX_QUOTES} quotes (of ${quotes.length} total)`
      );
      quotes = quotes.slice(0, MAX_QUOTES);
    }
  }

  console.log(`Processing ${quotes.length} Lebanon quotes\n`);

  const results: QuoteUpdateResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    console.log(`[${i + 1}/${quotes.length}] Processing quote ${quote.id}...`);

    try {
      const oldEscalator = parseFloat(String(quote.escalatorRate));
      const oldDepositUsd = parseFloat(String(quote.protocolDepositUsd6)) / 1e6;
      const oldEfficiency = Number(quote.efficiencyScore);

      const quoteResult = await computeProjectQuote({
        weeklyConsumptionMWh: parseFloat(String(quote.weeklyConsumptionMWh)),
        systemSizeKw: parseFloat(String(quote.systemSizeKw)),
        electricityPricePerKwh: parseFloat(String(quote.electricityPricePerKwh)),
        latitude: parseFloat(String(quote.latitude)),
        longitude: parseFloat(String(quote.longitude)),
        override: {
          discountRate: parseFloat(String(quote.discountRate)),
          escalatorRate: NEW_ESCALATOR_RATE,
          years: Number(quote.years),
          carbonOffsetsPerMwh: parseFloat(String(quote.carbonOffsetsPerMwh)),
        },
      });

      const newDepositUsd = parseFloat(quoteResult.protocolDepositUsd6) / 1e6;

      console.log(
        `  Escalator: ${oldEscalator.toFixed(4)} → ${quoteResult.escalatorRate.toFixed(
          4
        )}`
      );
      console.log(
        `  Deposit: $${oldDepositUsd.toFixed(
          2
        )} → $${newDepositUsd.toFixed(2)}`
      );
      console.log(
        `  Efficiency: ${oldEfficiency.toFixed(
          2
        )} → ${quoteResult.efficiencyScore.toFixed(2)}`
      );

      if (DRY_RUN) {
        console.log("  🔍 Would update (dry run)\n");
      } else {
        await db
          .update(ProjectQuotes)
          .set({
            protocolDepositUsd6: quoteResult.protocolDepositUsd6,
            weeklyCredits: quoteResult.weeklyCredits.toString(),
            weeklyDebt: quoteResult.weeklyDebt.toString(),
            netWeeklyCc: quoteResult.netWeeklyCc.toString(),
            netCcPerMwh: quoteResult.netCcPerMwh.toString(),
            weeklyImpactAssetsWad: quoteResult.weeklyImpactAssetsWad,
            efficiencyScore: quoteResult.efficiencyScore,
            discountRate: quoteResult.discountRate.toFixed(4),
            escalatorRate: quoteResult.escalatorRate.toFixed(4),
            carbonOffsetsPerMwh: quoteResult.carbonOffsetsPerMwh.toFixed(6),
            uncertaintyApplied: quoteResult.uncertaintyApplied.toFixed(4),
            debugJson: quoteResult.debugJson,
          })
          .where(eq(ProjectQuotes.id, quote.id));
        console.log("  ✅ Updated successfully\n");
      }

      successCount++;
      results.push({
        id: quote.id,
        success: true,
        oldEscalator,
        newEscalator: quoteResult.escalatorRate,
        oldDepositUsd,
        newDepositUsd,
        oldEfficiency,
        newEfficiency: quoteResult.efficiencyScore,
      });
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.log(`  ❌ Error: ${errorMessage}\n`);
      errorCount++;
      results.push({ id: quote.id, success: false, error: errorMessage });
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Total quotes: ${quotes.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  console.log("\n=== Deposit Changes ===");
  for (const result of results) {
    if (result.success && result.oldDepositUsd != null && result.newDepositUsd != null) {
      const diff = result.newDepositUsd - result.oldDepositUsd;
      if (Math.abs(diff) > 0.01) {
        console.log(
          `${result.id}: $${result.oldDepositUsd.toFixed(
            2
          )} → $${result.newDepositUsd.toFixed(2)} (${diff >= 0 ? "+" : ""}${diff.toFixed(
            2
          )})`
        );
      }
    }
  }

  if (errorCount > 0) {
    console.log("\n=== Errors ===");
    for (const result of results) {
      if (!result.success) {
        console.log(`${result.id}: ${result.error}`);
      }
    }
  }

  process.exit(0);
}

rerunLebanonEscalator();
