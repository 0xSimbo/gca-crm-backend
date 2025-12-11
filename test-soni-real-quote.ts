import { readFileSync } from "fs";
import { extractElectricityPriceFromUtilityBill } from "./src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "./src/routers/applications-router/helpers/computeProjectQuote";
import { getSunlightHoursAndCertificates } from "./src/routers/protocol-fee-router/utils/get-sunlight-hours-and-certificates";

const DAYS_PER_YEAR = 365.25;
const WEEKS_PER_YEAR = DAYS_PER_YEAR / 7;
const KW_PER_MW = 1_000;

function estimateWeeklyConsumptionMWh(
  dcCapacityMw: number,
  sunlightHoursPerDay: number
): number {
  const annualGenerationKwh =
    sunlightHoursPerDay * DAYS_PER_YEAR * dcCapacityMw * KW_PER_MW;
  return annualGenerationKwh / WEEKS_PER_YEAR / KW_PER_MW;
}

async function testSoniRealQuote() {
  console.log("=== Real Life Test - Soni's Project ===\n");

  // Real project data
  const projectData = {
    coordinates: {
      latitude: 27.48323,
      longitude: 73.259704,
    },
    dcCapacityMw: 0.46,
  };

  console.log("Project Details:");
  console.log(
    "  Location:",
    projectData.coordinates.latitude,
    ",",
    projectData.coordinates.longitude
  );
  console.log("  DC Capacity:", projectData.dcCapacityMw, "MW\n");

  const {
    average_sunlight: averageSunlightHoursPerDay,
    average_carbon_certificates: carbonOffsetsPerMwh,
  } = await getSunlightHoursAndCertificates(projectData.coordinates);
  const weeklyConsumptionMWh = estimateWeeklyConsumptionMWh(
    projectData.dcCapacityMw,
    averageSunlightHoursPerDay
  );
  const systemSizeKw = projectData.dcCapacityMw * KW_PER_MW;

  console.log("Derived Inputs:");
  console.log(
    "  Average Sunlight Hours:",
    averageSunlightHoursPerDay.toFixed(2),
    "hrs/day"
  );
  console.log("  Weekly Consumption:", weeklyConsumptionMWh.toFixed(4), "MWh");
  console.log("  System Size:", systemSizeKw.toFixed(0), "kW\n");

  // Step 1: Test PDF extraction
  console.log("=== Step 1: Extract Electricity Price from PDF ===");
  const pdfPath =
    "./tests/project-quotes/required_second_utility_bill_soni.pdf";

  try {
    const pdfBuffer = readFileSync(pdfPath);
    console.log("PDF loaded:", (pdfBuffer.length / 1024).toFixed(2), "KB");

    const extracted = await extractElectricityPriceFromUtilityBill(
      pdfBuffer,
      "required_second_utility_bill_soni.pdf",
      "application/pdf",
      "IN-RJ"
    );

    console.log("\n✅ AI Extraction Results:");
    const targetPricePerKwh = 0.0835;
    const priceDelta = Math.abs(
      extracted.result.pricePerKwh - targetPricePerKwh
    );
    console.log("  Price per kWh: $" + extracted.result.pricePerKwh.toFixed(4));
    console.log(
      "  Confidence:",
      (extracted.result.confidence * 100).toFixed(1) + "%"
    );
    console.log("  Rationale:", extracted.result.rationale);
    console.log("  Target Price: $" + targetPricePerKwh.toFixed(4));
    console.log("  Delta vs Target: $" + priceDelta.toFixed(4));
    if (priceDelta > 0.01) {
      console.warn(
        "⚠️ Extracted price deviates by more than $0.01 from the expected $0.0835."
      );
    }

    // Step 2: Compute quote with extracted price
    console.log("\n=== Step 2: Compute Protocol Deposit ===");

    const quoteResult = await computeProjectQuote({
      weeklyConsumptionMWh,
      systemSizeKw,
      electricityPricePerKwh: extracted.result.pricePerKwh,
      latitude: projectData.coordinates.latitude,
      longitude: projectData.coordinates.longitude,
      override: {
        carbonOffsetsPerMwh,
      },
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

testSoniRealQuote().catch(console.error);
