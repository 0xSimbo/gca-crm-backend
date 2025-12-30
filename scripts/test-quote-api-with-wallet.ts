/**
 * Partner Integration Example - Project Quote API
 *
 * This script demonstrates how to create a project quote using wallet signature authentication.
 * Partners can use this as a reference implementation for integrating with the Glow quotes API.
 *
 * Requirements:
 * - Private key in .env as TEST_WALLET_PRIVATE_KEY
 * - Utility bill PDF file
 * - Hub account created with the same wallet (see below)
 *
 * IMPORTANT - Create Hub Account First:
 * Before creating quotes via the API, you must first create an account on the Glow Hub
 * using the SAME wallet address that you'll use to sign quote requests.
 *
 * 1. Visit: https://hub.glow.org/login
 * 2. Connect with the wallet you'll use for API quotes
 * 3. Complete account creation
 * 4. Then use that same wallet's private key for TEST_WALLET_PRIVATE_KEY
 *
 * This allows you to view and manage your quotes through the hub dashboard after creation.
 *
 * Usage:
 * bun run scripts/test-quote-api-with-wallet.ts
 *
 * Environments:
 * - Staging:    https://gca-crm-backend-staging.up.railway.app/quotes/project
 * - Production: https://gca-crm-backend-production-1f2a.up.railway.app/quotes/project
 *
 * Rate Limit: 100 quotes per hour (global)
 *
 * Note: Test on staging first before using production
 */

import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { createMessageToSign } from "../src/handlers/walletSignatureHandler";

// Set API_URL to test locally or on staging:
// API_URL=http://localhost:3005 bun run scripts/test-quote-api-with-wallet.ts
// API_URL=https://gca-crm-backend-staging.up.railway.app bun run scripts/test-quote-api-with-wallet.ts
const API_URL =
  process.env.API_URL ?? "https://gca-crm-backend-production-1f2a.up.railway.app";

interface QuoteRequestData {
  annualConsumptionMWh: string;
  systemSizeKw: string;
  latitude: string;
  longitude: string;
  timestamp: number;
}

//TODO: think about partners.

/**
 * Example API Response:
 *
 * {
 *   "quoteId": "6d2f0813-ac43-4081-b177-3c2aff5a609b",
 *   "walletAddress": "0x5252fda14a149c01ea5a1d6514a9c1369e4c70b4",
 *   "userId": "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
 *   "regionCode": "US-MO",
 *   "protocolDeposit": {
 *     "usd": 38348.28058783432,
 *     "usd6Decimals": "38348280588"
 *   },
 *   "carbonMetrics": {
 *     "weeklyCredits": 0.1368393603993804,
 *     "weeklyDebt": 0.03977957978583274,
 *     "netWeeklyCc": 0.09705978061354767,
 *     "netCcPerMwh": 0.2555368635463763,
 *     "carbonOffsetsPerMwh": 0.554258,
 *     "uncertaintyApplied": 0.35
 *   },
 *   "efficiency": {
 *     "score": 25.31007365266847,
 *     "weeklyImpactAssetsWad": "97059780613547664"
 *   },
 *   "rates": {
 *     "discountRate": 0.075,
 *     "escalatorRate": 0.0242,
 *     "commitmentYears": 30
 *   },
 *   "extraction": {
 *     "electricityPricePerKwh": 0.1012,
 *     "confidence": 0.95,
 *     "rationale": "Extracted from utility bill using AI",
 *     "utilityBillUrl": "https://pub-65d7379333b140c5a7e4d6e74d173542.r2.dev/utility-bills/1763132922475-utility_bill.pdf"
 *   },
 *   "debug": {
 *     "inputs": {
 *       "weeklyConsumptionMWh": 0.3798269230769231,
 *       "systemSizeKw": 18.96,
 *       "electricityPricePerKwh": 0.1012,
 *       "latitude": 39.0707091494141,
 *       "longitude": -94.35609788750925
 *     },
 *     "rates": {
 *       "discountRate": 0.075,
 *       "escalatorRate": 0.0242,
 *       "years": 30,
 *       "foundState": "Missouri"
 *     },
 *     "protocolDeposit": {
 *       "annualKwh": 19823.456423076922,
 *       "firstYearCashFlow": 2005.7201272307693,
 *       "formula": "Monthly NPV with escalating cash flows",
 *       "protocolDepositUsd": 38348.28058783432,
 *       "protocolDepositUsd6": "38348280588"
 *     },
 *     "carbonMetrics": {
 *       "carbonOffsetsPerMwh": 0.5542579531137882,
 *       "uncertaintyApplied": 0.35,
 *       "weeklyCredits": 0.1368393603993804,
 *       "weeklyDebt": 0.03977957978583274,
 *       "netWeeklyCc": 0.09705978061354767,
 *       "netCcPerMwh": 0.2555368635463763
 *     },
 *     "efficiency": {
 *       "weeklyImpactAssetsWad": "97059780613547664",
 *       "efficiencyScore": 25.31007365266847
 *     }
 *   }
 * }
 */

async function testQuoteAPIWithWallet() {
  const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "TEST_WALLET_PRIVATE_KEY not found in .env. Please add your private key."
    );
  }

  const wallet = new Wallet(privateKey);

  // Prepare quote data
  const quoteData: QuoteRequestData = {
    annualConsumptionMWh: "19.823456423076922",
    systemSizeKw: "18.96",
    latitude: "39.0707091494141",
    longitude: "-94.35609788750925",
    timestamp: Date.now(),
  };

  // Create message and sign it
  const messageToSign = createMessageToSign({
    // createMessageToSign expects the first segment as `weeklyConsumptionMWh`,
    // but our API now signs annualConsumptionMWh in that position.
    weeklyConsumptionMWh: quoteData.annualConsumptionMWh,
    systemSizeKw: quoteData.systemSizeKw,
    latitude: quoteData.latitude,
    longitude: quoteData.longitude,
    timestamp: quoteData.timestamp,
  });
  const signature = await wallet.signMessage(messageToSign);

  // Load utility bill
  const pdfPath = "./tests/project-quotes/required_first_utility_bill.pdf";
  const pdfBuffer = readFileSync(pdfPath);

  // Prepare form data
  const formData = new FormData();
  formData.append("annualConsumptionMWh", quoteData.annualConsumptionMWh);
  formData.append("systemSizeKw", quoteData.systemSizeKw);
  formData.append("latitude", quoteData.latitude);
  formData.append("longitude", quoteData.longitude);
  formData.append("timestamp", quoteData.timestamp.toString());
  formData.append("signature", signature);

  // Optional: Add metadata to help identify the quote
  formData.append("metadata", "John Smith - Farm #123");

  const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], {
    type: "application/pdf",
  });
  const pdfFile = new File([pdfBlob], "utility_bill.pdf", {
    type: "application/pdf",
  });
  formData.append("utilityBill", pdfFile);

  // Make API request
  const response = await fetch(`${API_URL}/quotes/project`, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();

  if (response.ok) {
    return result;
  } else {
    throw new Error(result.error || `API request failed: ${response.status}`);
  }
}

// Run the test
testQuoteAPIWithWallet()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
