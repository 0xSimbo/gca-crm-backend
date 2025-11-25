import { db } from "../src/db/db";
import { ProjectQuotes } from "../src/db/schema";
import { extractElectricityPriceFromUtilityBill } from "../src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "../src/routers/applications-router/helpers/computeProjectQuote";
import { eq } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

async function downloadPdfFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fixWattsToKw() {
  console.log("=== Fixing Quotes with Watts → kW Conversion ===");
  if (DRY_RUN) {
    console.log("🔍 DRY RUN MODE - No changes will be saved\n");
  } else {
    console.log("⚠️  LIVE MODE - Changes will be saved to database\n");
  }

  // Fetch all quotes
  const allQuotes = await db.query.ProjectQuotes.findMany({
    orderBy: (q, { desc }) => [desc(q.createdAt)],
  });

  // Filter quotes where netWeeklyCc is 0 AND system size is suspiciously large (> 100 kW for residential)
  const suspectQuotes = allQuotes.filter((q) => {
    const netWeeklyCc = parseFloat(q.netWeeklyCc || "0");
    const systemSize = parseFloat(q.systemSizeKw);
    // Residential systems are typically 3-25 kW
    // If netWeeklyCc is 0 and system size > 100 kW, it's likely a watts mistake
    return netWeeklyCc === 0 && systemSize > 100;
  });

  console.log(
    `Found ${suspectQuotes.length} quotes with zero Net CC and large system sizes:\n`
  );

  for (const quote of suspectQuotes) {
    const oldSystemSize = parseFloat(quote.systemSizeKw);
    const newSystemSize = oldSystemSize / 1000;
    console.log(`  ${quote.id}:`);
    console.log(`    System Size: ${oldSystemSize} kW → ${newSystemSize} kW`);
    console.log(`    Weekly Consumption: ${quote.weeklyConsumptionMWh} MWh`);
  }

  if (suspectQuotes.length === 0) {
    console.log("No quotes to fix!");
    process.exit(0);
  }

  console.log("\n--- Processing ---\n");

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < suspectQuotes.length; i++) {
    const quote = suspectQuotes[i];
    const oldSystemSize = parseFloat(quote.systemSizeKw);
    const newSystemSize = oldSystemSize / 1000;

    console.log(
      `[${i + 1}/${suspectQuotes.length}] Fixing quote ${quote.id}...`
    );
    console.log(`  System Size: ${oldSystemSize} kW → ${newSystemSize} kW`);

    try {
      // Download the utility bill to re-extract price
      console.log(`  Downloading utility bill...`);
      const pdfBuffer = await downloadPdfFromUrl(quote.utilityBillUrl);

      // Re-extract the electricity price
      console.log(`  Extracting electricity price...`);
      const extractionResult = await extractElectricityPriceFromUtilityBill(
        pdfBuffer,
        "utility-bill.pdf",
        "application/pdf"
      );
      const newPrice = extractionResult.result.pricePerKwh;

      // Re-compute the quote with CORRECTED system size
      console.log(`  Computing quote with corrected system size...`);
      const quoteResult = await computeProjectQuote({
        weeklyConsumptionMWh: parseFloat(quote.weeklyConsumptionMWh),
        systemSizeKw: newSystemSize, // FIXED!
        electricityPricePerKwh: newPrice,
        latitude: parseFloat(quote.latitude),
        longitude: parseFloat(quote.longitude),
      });

      console.log(
        `  New Weekly Credits: ${quoteResult.weeklyCredits.toFixed(4)}`
      );
      console.log(`  New Weekly Debt: ${quoteResult.weeklyDebt.toFixed(4)}`);
      console.log(`  New Net Weekly CC: ${quoteResult.netWeeklyCc.toFixed(4)}`);
      console.log(
        `  New Protocol Deposit: $${quoteResult.protocolDepositUsd.toFixed(2)}`
      );

      if (DRY_RUN) {
        console.log(`  🔍 Would update (dry run)\n`);
      } else {
        console.log(`  Updating database...`);
        await db
          .update(ProjectQuotes)
          .set({
            systemSizeKw: newSystemSize.toFixed(3),
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
        console.log(`  ✅ Updated successfully\n`);
      }

      successCount++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.log(`  ❌ Error: ${errorMessage}\n`);
      errorCount++;
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("\n=== Summary ===");
  console.log(`Total quotes fixed: ${suspectQuotes.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  process.exit(0);
}

fixWattsToKw().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
