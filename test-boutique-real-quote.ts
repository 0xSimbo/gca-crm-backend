import { readFileSync } from "fs";
import { extractElectricityPriceFromUtilityBill } from "./src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "./src/routers/applications-router/helpers/computeProjectQuote";

async function testBoutiqueRealQuote() {
  console.log("=== Real Life Test - Boutique Project ===\n");

  // Real project data
  const projectData = {
    coordinates: {
      latitude: 28.02552,
      longitude: 73.05934,
    },
    annualConsumptionMWh: (0.7 * (365.25 / 7)).toString(),
    systemSizeKw: 700, // 0.7 MW
  };

  const weeklyConsumptionMWh =
    parseFloat(projectData.annualConsumptionMWh) / (365.25 / 7);

  console.log("Project Details:");
  console.log(
    "  Location:",
    projectData.coordinates.latitude,
    ",",
    projectData.coordinates.longitude
  );
  console.log(
    "  Annual Consumption:",
    projectData.annualConsumptionMWh,
    "MWh"
  );
  console.log("  Weekly Consumption (derived):", weeklyConsumptionMWh, "MWh");
  console.log("  System Size:", projectData.systemSizeKw, "kW\n");

  // Step 1: Test PDF extraction
  console.log("=== Step 1: Extract Electricity Price from PDF ===");
  const pdfPath =
    "./tests/project-quotes/required_second_utility_bill_boutique.pdf";

  try {
    const pdfBuffer = readFileSync(pdfPath);
    console.log("PDF loaded:", (pdfBuffer.length / 1024).toFixed(2), "KB");

    const extracted = await extractElectricityPriceFromUtilityBill(
      pdfBuffer,
      "required_second_utility_bill_boutique.pdf",
      "application/pdf",
      "IN-RJ"
    );

    console.log("\n✅ AI Extraction Results:");
    console.log("  Price per kWh: $" + extracted.result.pricePerKwh.toFixed(4));
    console.log(
      "  Confidence:",
      (extracted.result.confidence * 100).toFixed(1) + "%"
    );
    console.log("  Rationale:", extracted.result.rationale);

    // Step 2: Compute quote with extracted price
    console.log("\n=== Step 2: Compute Protocol Deposit ===");

    const quoteResult = await computeProjectQuote({
      weeklyConsumptionMWh,
      systemSizeKw: projectData.systemSizeKw,
      electricityPricePerKwh: extracted.result.pricePerKwh,
      latitude: projectData.coordinates.latitude,
      longitude: projectData.coordinates.longitude,
    });

    console.log("\n✅ Quote Computation Results:");
    console.log(
      "  Protocol Deposit: $" + quoteResult.protocolDepositUsd.toFixed(2)
    );
    console.log(
      "  Protocol Deposit (6 decimals):",
      quoteResult.protocolDepositUsd6
    );

    console.log("\n=== Carbon Metrics ===");
    console.log(
      "  Weekly Credits:",
      quoteResult.weeklyCredits.toFixed(4),
      "tCO2e"
    );
    console.log("  Weekly Debt:", quoteResult.weeklyDebt.toFixed(4), "tCO2e");
    console.log(
      "  Net Weekly CC:",
      quoteResult.netWeeklyCc.toFixed(4),
      "tCO2e"
    );
    console.log(
      "  Net CC/MWh:",
      quoteResult.netCcPerMwh.toFixed(4),
      "tCO2e/MWh"
    );

    console.log("\n=== Rates Used ===");
    console.log(
      "  Discount Rate:",
      (quoteResult.discountRate * 100).toFixed(2) + "%"
    );
    console.log(
      "  Escalator Rate:",
      (quoteResult.escalatorRate * 100).toFixed(2) + "%"
    );
    console.log("  Commitment:", quoteResult.years, "years");

    console.log("\n=== Efficiency ===");
    console.log("  Score:", quoteResult.efficiencyScore.toFixed(4));
    console.log("  Weekly Impact Assets:", quoteResult.weeklyImpactAssetsWad);
  } catch (error) {
    console.error("❌ Test failed:", (error as Error).message);
    console.error(error);
  }
}

testBoutiqueRealQuote().catch(console.error);


