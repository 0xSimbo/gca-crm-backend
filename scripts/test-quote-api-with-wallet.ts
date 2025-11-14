/**
 * Test Script & Partner Integration Example
 *
 * This script demonstrates how to create a project quote using wallet signature authentication.
 * Partners can use this as a reference implementation for integrating with the quotes API.
 *
 * Requirements:
 * - Private key in .env as TEST_WALLET_PRIVATE_KEY
 * - Utility bill PDF file
 *
 * Usage:
 * bun run scripts/test-quote-api-with-wallet.ts
 */

import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { createMessageToSign } from "../src/handlers/walletSignatureHandler";

interface QuoteRequestData {
  weeklyConsumptionMWh: string;
  systemSizeKw: string;
  latitude: string;
  longitude: string;
  timestamp: number;
}

async function testQuoteAPIWithWallet() {
  console.log("=== Project Quote API - Wallet Signature Test ===\n");

  // Step 1: Load wallet from environment
  const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ ERROR: TEST_WALLET_PRIVATE_KEY not found in .env");
    console.log("\nPlease add your private key to .env:");
    console.log("TEST_WALLET_PRIVATE_KEY=0x...");
    process.exit(1);
  }

  const wallet = new Wallet(privateKey);
  console.log("✅ Wallet loaded");
  console.log("   Address:", wallet.address);

  // Step 2: Prepare quote data
  const quoteData: QuoteRequestData = {
    weeklyConsumptionMWh: "0.3798269230769231", // 19,751 kWh annually / 52 weeks / 1000
    systemSizeKw: "0.01896", // From planset
    latitude: "39.0707091494141", // Independence, MO
    longitude: "-94.35609788750925",
    timestamp: Date.now(),
  };

  console.log("\n=== Step 2: Quote Data ===");
  console.log("Location: Independence, MO (auto-detected as US-MO)");
  console.log("Weekly Consumption:", quoteData.weeklyConsumptionMWh, "MWh");
  console.log("System Size:", quoteData.systemSizeKw, "kW");
  console.log("Coordinates:", quoteData.latitude, quoteData.longitude);
  console.log("Timestamp:", new Date(quoteData.timestamp).toISOString());

  // Step 3: Create message and sign it
  console.log("\n=== Step 3: Create & Sign Message ===");
  const messageToSign = createMessageToSign(quoteData);
  console.log("Message to sign:", messageToSign);

  const signature = await wallet.signMessage(messageToSign);
  console.log("✅ Message signed");
  console.log("   Signature:", signature.substring(0, 20) + "...");
  console.log("   Length:", signature.length, "characters");

  // Step 4: Load utility bill
  console.log("\n=== Step 4: Load Utility Bill ===");
  const pdfPath = "./tests/project-quotes/required_first_utility_bill.pdf";

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = readFileSync(pdfPath);
    console.log("✅ PDF loaded");
    console.log("   Path:", pdfPath);
    console.log("   Size:", (pdfBuffer.length / 1024).toFixed(2), "KB");
  } catch (error) {
    console.error("❌ Failed to load PDF:", (error as Error).message);
    console.log("\nMake sure the utility bill PDF exists at:");
    console.log(pdfPath);
    process.exit(1);
  }

  // Step 5: Prepare API request
  console.log("\n=== Step 5: API Request Structure ===");

  const apiEndpoint = process.env.API_URL || "http://localhost:3005";
  const fullUrl = `${apiEndpoint}/quotes/project`;

  console.log("Endpoint:", fullUrl);
  console.log("\nRequest body structure:");
  console.log({
    weeklyConsumptionMWh: quoteData.weeklyConsumptionMWh,
    systemSizeKw: quoteData.systemSizeKw,
    latitude: quoteData.latitude,
    longitude: quoteData.longitude,
    timestamp: quoteData.timestamp,
    signature: signature.substring(0, 20) + "...",
    utilityBill: "[PDF File]",
  });

  // Step 6: Make the API request
  console.log("\n=== Step 6: Send Request to API ===");

  try {
    // For multipart/form-data, we need to send as JSON object for the non-file fields
    const requestBody = {
      weeklyConsumptionMWh: quoteData.weeklyConsumptionMWh,
      systemSizeKw: quoteData.systemSizeKw,
      latitude: quoteData.latitude,
      longitude: quoteData.longitude,
      timestamp: quoteData.timestamp,
      signature: signature,
    };

    const formData = new FormData();
    formData.append("weeklyConsumptionMWh", quoteData.weeklyConsumptionMWh);
    formData.append("systemSizeKw", quoteData.systemSizeKw);
    formData.append("latitude", quoteData.latitude);
    formData.append("longitude", quoteData.longitude);
    formData.append("timestamp", quoteData.timestamp.toString());
    formData.append("signature", signature);

    // Create a Blob from the PDF buffer
    const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], {
      type: "application/pdf",
    });
    const pdfFile = new File([pdfBlob], "utility_bill.pdf", {
      type: "application/pdf",
    });
    formData.append("utilityBill", pdfFile);

    console.log("Sending request to:", fullUrl);

    const response = await fetch(fullUrl, {
      method: "POST",
      body: formData,
    });

    console.log("Response status:", response.status, response.statusText);

    const result = await response.json();

    if (response.ok) {
      console.log("\n✅ SUCCESS! Quote created");
      console.log("\n=== Quote Response ===");
      console.log("Quote ID:", result.quoteId);
      console.log("Wallet Address:", result.walletAddress);
      console.log("User ID:", result.userId || "(not linked to existing user)");
      console.log("Region Code:", result.regionCode);
      console.log("\nProtocol Deposit:");
      console.log("  USD:", result.protocolDeposit.usd.toFixed(2));
      console.log("  USD (6 decimals):", result.protocolDeposit.usd6Decimals);
      console.log("\nCarbon Metrics:");
      console.log(
        "  Weekly Credits:",
        result.carbonMetrics.weeklyCredits.toFixed(4)
      );
      console.log("  Weekly Debt:", result.carbonMetrics.weeklyDebt.toFixed(4));
      console.log(
        "  Net Weekly CC:",
        result.carbonMetrics.netWeeklyCc.toFixed(4)
      );
      console.log("  Net CC/MWh:", result.carbonMetrics.netCcPerMwh.toFixed(4));
      console.log("\nEfficiency:");
      console.log("  Score:", result.efficiency.score.toFixed(4));
      console.log("\nExtraction:");
      console.log(
        "  Price/kWh: $" + result.extraction.electricityPricePerKwh.toFixed(4)
      );
      console.log(
        "  Confidence:",
        (result.extraction.confidence * 100).toFixed(1) + "%"
      );
      console.log("  Rationale:", result.extraction.rationale);

      console.log("\n=== Retrieve Quote Example ===");
      console.log(`GET ${apiEndpoint}/quotes/project/quote/${result.quoteId}`);
      console.log(`GET ${apiEndpoint}/quotes/project/${wallet.address}`);
    } else {
      console.error("\n❌ API Request Failed");
      console.error("Status:", response.status);
      console.error("Error:", result.error || result);
    }
  } catch (error) {
    console.error("\n❌ Request failed:", (error as Error).message);
    console.error("\nMake sure the API server is running:");
    console.error("  bun run dev");
  }

  console.log("\n=== Test Complete ===");
}

// Run the test
testQuoteAPIWithWallet().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
