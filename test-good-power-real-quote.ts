import { readFileSync } from "fs";
import { extractElectricityPriceFromUtilityBill } from "./src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "./src/routers/applications-router/helpers/computeProjectQuote";

async function testGoodPowerRealQuote() {
  console.log("=== Real Life Test - Good Power Project ===\n");

  const projectData = {
    coordinates: {
      latitude: 34.0215,
      longitude: -85.205,
    },
    systemSizeKw: 10.12,
    weeklyConsumptionMWh: 0.276,
    expectedElectricityPrice: 0.1817, // $79.42 / 437 kWh (excludes income-based discounts)
  };

  console.log("Project Details:");
  console.log(
    "  Location:",
    projectData.coordinates.latitude,
    ",",
    projectData.coordinates.longitude
  );
  console.log("  System Size:", projectData.systemSizeKw, "kW");
  console.log("  Weekly Consumption:", projectData.weeklyConsumptionMWh, "MWh");
  console.log(
    "  Expected Electricity Price: $" +
      projectData.expectedElectricityPrice.toFixed(4) +
      "/kWh\n"
  );

  // Step 1: Test PDF extraction
  console.log("=== Step 1: Extract Electricity Price from PDF ===");
  const pdfPath =
    "./tests/project-quotes/required_first_utility_bill__good_power.pdf";

  try {
    const pdfBuffer = readFileSync(pdfPath);
    console.log("PDF loaded:", (pdfBuffer.length / 1024).toFixed(2), "KB");

    const extracted = await extractElectricityPriceFromUtilityBill(
      pdfBuffer,
      "required_first_utility_bill__good_power.pdf",
      "application/pdf"
    );

    console.log("\n✅ AI Extraction Results:");
    console.log("  Price per kWh: $" + extracted.result.pricePerKwh.toFixed(4));
    console.log(
      "  Confidence:",
      (extracted.result.confidence * 100).toFixed(1) + "%"
    );
    console.log("  Rationale:", extracted.result.rationale);

    const priceDiff = Math.abs(
      extracted.result.pricePerKwh - projectData.expectedElectricityPrice
    );
    const priceMatch = priceDiff < 0.01; // Within 1 cent

    console.log(
      "\n  Expected: $" + projectData.expectedElectricityPrice.toFixed(4)
    );
    console.log("  Difference:", (priceDiff * 100).toFixed(2) + " cents");
    console.log("  Match:", priceMatch ? "✅ CLOSE ENOUGH" : "⚠️ DIFFERENT");

    // Step 2: Compute quote with extracted price
    console.log("\n=== Step 2: Compute Protocol Deposit ===");

    const quoteResult = await computeProjectQuote({
      weeklyConsumptionMWh: projectData.weeklyConsumptionMWh,
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

    console.log("\n=== Summary ===");
    if (priceMatch) {
      console.log("✅ ALL CHECKS PASSED - Within tolerance!");
    } else {
      console.log("⚠️ Price extraction variance detected:");
      console.log(
        "  - Extracted: $" +
          extracted.result.pricePerKwh.toFixed(4) +
          "/kWh vs Expected: $" +
          projectData.expectedElectricityPrice.toFixed(4) +
          "/kWh"
      );
      console.log("  - Difference: " + (priceDiff * 100).toFixed(2) + " cents");
    }
    console.log(
      "  Electricity Price: $" +
        extracted.result.pricePerKwh.toFixed(4) +
        "/kWh"
    );
    console.log(
      "  Protocol Deposit: $" + quoteResult.protocolDepositUsd.toFixed(2)
    );
  } catch (error) {
    console.error("❌ Test failed:", (error as Error).message);
    console.error(error);
  }
}

testGoodPowerRealQuote().catch(console.error);
