/**
 * Local test: Single project quote endpoint
 *
 * Usage:
 *   TEST_WALLET_PRIVATE_KEY=0x... bun run tests/project-quotes/test-single-quote-api.ts
 *
 * Notes:
 * - Requires your local API running at http://localhost:3005
 * - Requires the same env config you use for quote extraction (Gemini + R2, etc.)
 */

import { Wallet } from "ethers";
import { readFileSync } from "fs";
import { createMessageToSign } from "../../src/handlers/walletSignatureHandler";

const API_URL = process.env.API_URL ?? "http://localhost:3005";

async function main() {
  const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "TEST_WALLET_PRIVATE_KEY not found. Set it to the wallet private key used to sign quote requests."
    );
  }

  const wallet = new Wallet(privateKey);

  const timestamp = Date.now();
  const request = {
    annualConsumptionMWh: "19.823456423076922",
    systemSizeKw: "18.96",
    latitude: "39.0707091494141",
    longitude: "-94.35609788750925",
    timestamp: timestamp.toString(),
    signature: await wallet.signMessage(
      createMessageToSign({
        // createMessageToSign expects the first segment as `weeklyConsumptionMWh`,
        // but our API now signs annualConsumptionMWh in that position.
        weeklyConsumptionMWh: "19.823456423076922",
        systemSizeKw: "18.96",
        latitude: "39.0707091494141",
        longitude: "-94.35609788750925",
        timestamp,
      })
    ),
    metadata: "local-single-test",
  };

  const pdfPath = "./tests/project-quotes/required_first_utility_bill.pdf";
  const pdfBuffer = readFileSync(pdfPath);

  const formData = new FormData();
  formData.append("annualConsumptionMWh", request.annualConsumptionMWh);
  formData.append("systemSizeKw", request.systemSizeKw);
  formData.append("latitude", request.latitude);
  formData.append("longitude", request.longitude);
  formData.append("timestamp", request.timestamp);
  formData.append("signature", request.signature);
  formData.append("metadata", request.metadata);

  const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], {
    type: "application/pdf",
  });
  const pdfFile = new File([pdfBlob], "utility_bill.pdf", {
    type: "application/pdf",
  });
  formData.append("utilityBill", pdfFile);

  console.log(`[single] POST ${API_URL}/quotes/project`);
  const response = await fetch(`${API_URL}/quotes/project`, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  console.log("[single] status:", response.status);
  console.log("[single] response:", JSON.stringify(result, null, 2));

  if (!response.ok) {
    throw new Error(result?.error || `Single quote failed: HTTP ${response.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });


