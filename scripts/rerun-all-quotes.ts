import { db } from "../src/db/db";
import { ProjectQuotes } from "../src/db/schema";
import { extractElectricityPriceFromUtilityBill } from "../src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "../src/routers/applications-router/helpers/computeProjectQuote";
import { eq } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = process.argv.find((arg) => arg.startsWith("--limit="));
const MAX_QUOTES = LIMIT ? parseInt(LIMIT.split("=")[1]) : Infinity;
const ID_ARG = process.argv.find((arg) => arg.startsWith("--id="));
const SPECIFIC_ID = ID_ARG ? ID_ARG.split("=")[1] : null;

interface QuoteUpdateResult {
  id: string;
  success: boolean;
  oldPrice?: number;
  newPrice?: number;
  oldDeposit?: string;
  newDeposit?: string;
  error?: string;
}

async function downloadPdfFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function rerunAllQuotes() {
  console.log("=== Rerunning All Project Quotes ===");
  if (DRY_RUN) {
    console.log("🔍 DRY RUN MODE - No changes will be saved\n");
  } else {
    console.log("⚠️  LIVE MODE - Changes will be saved to database\n");
  }

  // Fetch quotes
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
      orderBy: (q, { desc }) => [desc(q.createdAt)],
    });

    if (MAX_QUOTES < quotes.length) {
      console.log(
        `Limiting to first ${MAX_QUOTES} quotes (of ${quotes.length} total)`
      );
      quotes = quotes.slice(0, MAX_QUOTES);
    }
  }

  console.log(`Processing ${quotes.length} quotes\n`);

  const results: QuoteUpdateResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    console.log(`[${i + 1}/${quotes.length}] Processing quote ${quote.id}...`);

    try {
      // Download the utility bill
      console.log(`  Downloading utility bill from ${quote.utilityBillUrl}`);
      const pdfBuffer = await downloadPdfFromUrl(quote.utilityBillUrl);
      console.log(`  Downloaded ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

      // Re-extract the electricity price
      console.log(`  Extracting electricity price...`);
      const extractionResult = await extractElectricityPriceFromUtilityBill(
        pdfBuffer,
        "utility-bill.pdf",
        "application/pdf",
        quote.regionCode
      );

      const newPrice = extractionResult.result.pricePerKwh;
      const oldPrice = parseFloat(quote.electricityPricePerKwh);
      console.log(
        `  Old price: $${oldPrice.toFixed(
          4
        )}/kWh, New price: $${newPrice.toFixed(4)}/kWh`
      );

      // Re-compute the quote
      console.log(`  Computing quote...`);
      const quoteResult = await computeProjectQuote({
        weeklyConsumptionMWh: parseFloat(quote.weeklyConsumptionMWh),
        systemSizeKw: parseFloat(quote.systemSizeKw),
        electricityPricePerKwh: newPrice,
        latitude: parseFloat(quote.latitude),
        longitude: parseFloat(quote.longitude),
      });

      const oldDeposit = quote.protocolDepositUsd6;
      const newDeposit = quoteResult.protocolDepositUsd6;
      console.log(
        `  Old deposit: $${(parseInt(oldDeposit) / 1e6).toFixed(
          2
        )}, New deposit: $${quoteResult.protocolDepositUsd.toFixed(2)}`
      );
      console.log(`  --- Quote Inputs ---`);
      console.log(`  Weekly Consumption: ${quote.weeklyConsumptionMWh} MWh`);
      console.log(`  System Size: ${quote.systemSizeKw} kW`);
      console.log(`  --- Carbon Metrics ---`);
      console.log(`  Carbon Offsets/MWh: ${quoteResult.carbonOffsetsPerMwh}`);
      console.log(`  Uncertainty Applied: ${quoteResult.uncertaintyApplied}`);
      console.log(`  Weekly Credits: ${quoteResult.weeklyCredits}`);
      console.log(`  Weekly Debt: ${quoteResult.weeklyDebt}`);
      console.log(
        `  Net Weekly CC: ${quoteResult.netWeeklyCc} (max(0, credits - debt))`
      );
      console.log(`  Net CC per MWh: ${quoteResult.netCcPerMwh}`);

      // Update the database
      if (DRY_RUN) {
        console.log(`  🔍 Would update (dry run)`);
      } else {
        console.log(`  Updating database...`);
        await db
          .update(ProjectQuotes)
          .set({
            electricityPricePerKwh: newPrice.toFixed(5),
            priceConfidence: extractionResult.result.confidence.toFixed(3),
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
      }

      console.log(
        `  ✅ ${DRY_RUN ? "Would update" : "Updated"} successfully\n`
      );
      successCount++;

      results.push({
        id: quote.id,
        success: true,
        oldPrice,
        newPrice,
        oldDeposit,
        newDeposit,
      });
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.log(`  ❌ Error: ${errorMessage}`);
      console.log(`  PDF URL: ${quote.utilityBillUrl}`);
      console.log(`  Wallet: ${quote.walletAddress}\n`);
      errorCount++;

      results.push({
        id: quote.id,
        success: false,
        error: errorMessage,
      });
    }

    // Add a small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total quotes: ${quotes.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  // Print price changes
  console.log("\n=== Price Changes ===");
  for (const result of results) {
    if (result.success && result.oldPrice && result.newPrice) {
      const priceDiff = result.newPrice - result.oldPrice;
      const priceDiffPercent = ((priceDiff / result.oldPrice) * 100).toFixed(1);
      if (Math.abs(priceDiff) > 0.001) {
        console.log(
          `${result.id}: $${result.oldPrice.toFixed(
            4
          )} → $${result.newPrice.toFixed(4)} (${
            priceDiff > 0 ? "+" : ""
          }${priceDiffPercent}%)`
        );
      }
    }
  }

  // Print errors
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

rerunAllQuotes().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
