import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { createMessageToSign } from "./src/handlers/walletSignatureHandler";
import { extractElectricityPriceFromUtilityBill } from "./src/routers/applications-router/helpers/extractElectricityPrice";
import { computeProjectQuote } from "./src/routers/applications-router/helpers/computeProjectQuote";

async function testAndrewRealQuote() {
  console.log("=== Real Life Test - Andrew's Project ===\n");

  // Real project data from spreadsheet
  const projectData = {
    address: "1309 S Francis St, Longmont, CO 80501, USA",
    coordinates: {
      latitude: 40.14431191,
      longitude: -105.11670055,
    },
    systemSizeKw: 6.69, // 6.69 kWDC, 6.38 kWAC
    annualConsumption: 10528, // kWh
    weeklyConsumptionMWh: (10528 / 52 / 1000).toString(), // 0.2024615
    numberOfPanels: 22,
    startDate: "09/01/2025",
    expectedElectricityPrice: 0.1075, // $0.1075/kWh from spreadsheet
    expectedProtocolDeposit: 18658.30, // From spreadsheet
  };

  console.log("Project Details:");
  console.log("  Address:", projectData.address);
  console.log("  Location: Longmont, CO (should auto-detect as US-CO)");
  console.log("  System Size:", projectData.systemSizeKw, "kW");
  console.log("  Panels:", projectData.numberOfPanels);
  console.log("  Annual Consumption:", projectData.annualConsumption, "kWh");
  console.log("  Weekly Consumption:", projectData.weeklyConsumptionMWh, "MWh");
  console.log("  Expected Electricity Price: $" + projectData.expectedElectricityPrice.toFixed(4) + "/kWh");
  console.log("  Expected Protocol Deposit: $" + projectData.expectedProtocolDeposit.toFixed(2) + "\n");

  // Step 1: Test PDF extraction
  console.log("=== Step 1: Extract Electricity Price from PDF ===");
  const pdfPath = "./tests/project-quotes/required_second_utility_bill_andrew.pdf";
  
  try {
    const pdfBuffer = readFileSync(pdfPath);
    console.log("PDF loaded:", (pdfBuffer.length / 1024).toFixed(2), "KB");
    
    const extracted = await extractElectricityPriceFromUtilityBill(
      pdfBuffer,
      "required_second_utility_bill_andrew.pdf",
      "application/pdf"
    );
    
    console.log("\n✅ AI Extraction Results:");
    console.log("  Price per kWh: $" + extracted.result.pricePerKwh.toFixed(4));
    console.log("  Confidence:", (extracted.result.confidence * 100).toFixed(1) + "%");
    console.log("  Rationale:", extracted.result.rationale);
    
    const priceDiff = Math.abs(extracted.result.pricePerKwh - projectData.expectedElectricityPrice);
    const priceMatch = priceDiff < 0.01; // Within 1 cent
    
    console.log("\n  Expected: $" + projectData.expectedElectricityPrice.toFixed(4));
    console.log("  Difference:", (priceDiff * 100).toFixed(2) + " cents");
    console.log("  Match:", priceMatch ? "✅ CLOSE ENOUGH" : "⚠️ DIFFERENT");
    
    // Step 2: Compute quote with extracted price
    console.log("\n=== Step 2: Compute Protocol Deposit ===");
    
    const quoteResult = await computeProjectQuote({
      weeklyConsumptionMWh: parseFloat(projectData.weeklyConsumptionMWh),
      systemSizeKw: projectData.systemSizeKw,
      electricityPricePerKwh: extracted.result.pricePerKwh,
      latitude: projectData.coordinates.latitude,
      longitude: projectData.coordinates.longitude,
    });
    
    console.log("\n✅ Quote Computation Results:");
    console.log("  Protocol Deposit: $" + quoteResult.protocolDepositUsd.toFixed(2));
    console.log("  Protocol Deposit (6 decimals):", quoteResult.protocolDepositUsd6);
    
    const depositDiff = Math.abs(quoteResult.protocolDepositUsd - projectData.expectedProtocolDeposit);
    const depositMatchPercent = (depositDiff / projectData.expectedProtocolDeposit) * 100;
    
    console.log("\n  Expected: $" + projectData.expectedProtocolDeposit.toFixed(2));
    console.log("  Difference: $" + depositDiff.toFixed(2));
    console.log("  Variance:", depositMatchPercent.toFixed(2) + "%");
    console.log("  Match:", depositMatchPercent < 5 ? "✅ WITHIN 5%" : "⚠️ OFF BY " + depositMatchPercent.toFixed(1) + "%");
    
    console.log("\n=== Carbon Metrics ===");
    console.log("  Weekly Credits:", quoteResult.weeklyCredits.toFixed(4), "tCO2e");
    console.log("  Weekly Debt:", quoteResult.weeklyDebt.toFixed(4), "tCO2e");
    console.log("  Net Weekly CC:", quoteResult.netWeeklyCc.toFixed(4), "tCO2e");
    console.log("  Net CC/MWh:", quoteResult.netCcPerMwh.toFixed(4), "tCO2e/MWh");
    
    console.log("\n=== Rates Used ===");
    console.log("  Discount Rate:", (quoteResult.discountRate * 100).toFixed(2) + "%");
    console.log("  Escalator Rate:", (quoteResult.escalatorRate * 100).toFixed(2) + "%");
    console.log("  Commitment:", quoteResult.years, "years");
    
    console.log("\n=== Efficiency ===");
    console.log("  Score:", quoteResult.efficiencyScore.toFixed(4));
    console.log("  Weekly Impact Assets:", quoteResult.weeklyImpactAssetsWad);
    
    // Compare with spreadsheet
    console.log("\n=== Comparison with Spreadsheet ===");
    console.log("Expected NET Carbon Credit: 0.1031 (from spreadsheet row 24)");
    console.log("Actual NET Carbon Credit:", quoteResult.netWeeklyCc.toFixed(4));
    
    const carbonDiff = Math.abs(quoteResult.netWeeklyCc - 0.1031);
    console.log("Carbon Difference:", carbonDiff.toFixed(4), carbonDiff < 0.01 ? "✅" : "⚠️");
    
    console.log("\n=== Summary ===");
    if (priceMatch && depositMatchPercent < 5) {
      console.log("✅ ALL CHECKS PASSED - Implementation matches expected values!");
    } else {
      console.log("⚠️ Some variances detected:");
      if (!priceMatch) console.log("  - Electricity price extraction needs review");
      if (depositMatchPercent >= 5) console.log("  - Protocol deposit calculation has variance");
    }
    
  } catch (error) {
    console.error("❌ Test failed:", (error as Error).message);
    console.error(error);
  }
}

testAndrewRealQuote().catch(console.error);
