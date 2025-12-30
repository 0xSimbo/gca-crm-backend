import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { createMessageToSign } from "./src/handlers/walletSignatureHandler";
import { extractElectricityPriceFromUtilityBill } from "./src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "./src/routers/applications-router/helpers/computeProjectQuote";

async function testBenRealQuote() {
  console.log("=== Real Life Test - Ben's Project ===\n");

  // Real project data from spreadsheet
  const projectData = {
    address: "1018 E 4555 S, Salt Lake City, UT 84117, USA",
    coordinates: {
      latitude: 40.67248058,
      longitude: -111.86220056,
    },
    systemSizeKw: 10.01, // 10.01 kW-DC | 7.60 kW-AC
    annualConsumption: 14917, // kWh
    annualConsumptionMWh: (14917 / 1000).toString(), // 14.917
    numberOfPanels: 26,
    startDate: "08/01/2025",
    expectedElectricityPrice: 0.1286, // $0.1286/kWh from spreadsheet row 35
    expectedProtocolDeposit: 30154.8, // From spreadsheet row 14
  };

  const weeklyConsumptionMWh =
    parseFloat(projectData.annualConsumptionMWh) / (365.25 / 7);

  console.log("Project Details:");
  console.log("  Address:", projectData.address);
  console.log("  Location: Salt Lake City, UT (should auto-detect as US-UT)");
  console.log("  System Size:", projectData.systemSizeKw, "kW");
  console.log("  Panels:", projectData.numberOfPanels);
  console.log("  Annual Consumption:", projectData.annualConsumption, "kWh");
  console.log("  Annual Consumption:", projectData.annualConsumptionMWh, "MWh");
  console.log("  Weekly Consumption (derived):", weeklyConsumptionMWh, "MWh");
  console.log(
    "  Expected Electricity Price: $" +
      projectData.expectedElectricityPrice.toFixed(4) +
      "/kWh"
  );
  console.log(
    "  Expected Protocol Deposit: $" +
      projectData.expectedProtocolDeposit.toFixed(2) +
      "\n"
  );

  // Step 1: Test PDF extraction
  console.log("=== Step 1: Extract Electricity Price from PDF ===");
  const pdfPath = "./tests/project-quotes/required_first_utility_bill_ben.pdf";

  try {
    const pdfBuffer = readFileSync(pdfPath);
    console.log("PDF loaded:", (pdfBuffer.length / 1024).toFixed(2), "KB");

    const extracted = await extractElectricityPriceFromUtilityBill(
      pdfBuffer,
      "required_first_utility_bill_ben.pdf",
      "application/pdf",
      "US-UT"
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

    const depositDiff = Math.abs(
      quoteResult.protocolDepositUsd - projectData.expectedProtocolDeposit
    );
    const depositMatchPercent =
      (depositDiff / projectData.expectedProtocolDeposit) * 100;

    console.log(
      "\n  Expected: $" + projectData.expectedProtocolDeposit.toFixed(2)
    );
    console.log("  Difference: $" + depositDiff.toFixed(2));
    console.log("  Variance:", depositMatchPercent.toFixed(2) + "%");
    console.log(
      "  Match:",
      depositMatchPercent < 10
        ? "✅ WITHIN 10%"
        : "⚠️ OFF BY " + depositMatchPercent.toFixed(1) + "%"
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
    if (priceMatch && depositMatchPercent < 10) {
      console.log("✅ ALL CHECKS PASSED - Within tolerance!");
    } else {
      console.log("⚠️ Some variances detected:");
      if (!priceMatch)
        console.log(
          "  - Electricity price extraction: " +
            (priceDiff * 100).toFixed(2) +
            " cents off"
        );
      if (depositMatchPercent >= 10)
        console.log(
          "  - Protocol deposit: " +
            depositMatchPercent.toFixed(1) +
            "% variance"
        );
    }
  } catch (error) {
    console.error("❌ Test failed:", (error as Error).message);
    console.error(error);
  }
}

testBenRealQuote().catch(console.error);
