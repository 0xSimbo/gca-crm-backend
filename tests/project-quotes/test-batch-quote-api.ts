/**
 * Local test: Async batch quote endpoint
 *
 * Usage:
 *   TEST_WALLET_PRIVATE_KEY=0x... bun run tests/project-quotes/test-batch-quote-api.ts
 *
 * Notes:
 * - Requires your local API running at http://localhost:3005
 * - Requires the same env config you use for single quote extraction (Gemini + R2, etc.)
 */

import { Wallet } from "ethers";
import { readFileSync } from "fs";
import {
  createBatchMessageToSign,
  createMessageToSign,
} from "../../src/handlers/walletSignatureHandler";

const API_URL = process.env.API_URL ?? "http://localhost:3005";
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? "10", 10);

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const privateKey = process.env.TEST_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "TEST_WALLET_PRIVATE_KEY not found. Set it to the wallet private key used to sign quote requests."
    );
  }

  if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
    throw new Error("BATCH_SIZE must be a positive integer");
  }

  const wallet = new Wallet(privateKey);

  const base = {
    weeklyConsumptionMWh: "0.3798269230769231",
    systemSizeKw: "18.96",
    latitude: "39.0707091494141",
    longitude: "-94.35609788750925",
  };

  const pdfPath = "./tests/project-quotes/required_first_utility_bill.pdf";
  const pdfBuffer = readFileSync(pdfPath);

  const requests = await Promise.all(
    Array.from({ length: BATCH_SIZE }).map(async (_, index) => {
      const timestamp = Date.now() + index;
      const messageToSign = createMessageToSign({ ...base, timestamp });
      const signature = await wallet.signMessage(messageToSign);

      return {
        ...base,
        timestamp: timestamp.toString(),
        signature,
        metadata: `local-batch-test-${index + 1}`,
      };
    })
  );

  const formData = new FormData();
  formData.append("requests", JSON.stringify(requests));

  for (let i = 0; i < BATCH_SIZE; i++) {
    const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], {
      type: "application/pdf",
    });
    const pdfFile = new File([pdfBlob], `utility_bill_${i + 1}.pdf`, {
      type: "application/pdf",
    });
    formData.append("utilityBills", pdfFile);
  }

  console.log(
    `[batch] POST ${API_URL}/quotes/project/batch (items=${BATCH_SIZE})`
  );
  const response = await fetch(`${API_URL}/quotes/project/batch`, {
    method: "POST",
    body: formData,
  });

  const submitResult = await response.json();
  console.log("[batch] submit response:", submitResult);

  if (!response.ok) {
    throw new Error(
      submitResult?.error || `Batch submit failed: HTTP ${response.status}`
    );
  }

  const batchId = submitResult.batchId as string;
  if (!batchId) {
    throw new Error("No batchId returned by API");
  }

  const statusUrl = `${API_URL}/quotes/project/batch/${batchId}`;
  const maxPolls = Number.parseInt(process.env.MAX_POLLS ?? "300", 10); // ~10 minutes at 2s
  const pollIntervalMs = Number.parseInt(
    process.env.POLL_INTERVAL_MS ?? "2000",
    10
  );

  console.log(`[batch] polling ${statusUrl}`);

  for (let poll = 1; poll <= maxPolls; poll++) {
    const ts = Date.now();
    const pollSig = await wallet.signMessage(
      createBatchMessageToSign(batchId, ts)
    );
    const pollRes = await fetch(
      `${statusUrl}?timestamp=${ts}&signature=${encodeURIComponent(pollSig)}`
    );
    const status = await pollRes.json();

    if (!pollRes.ok) {
      console.log(`[batch] poll ${poll} error:`, status);
      throw new Error(
        status?.error || `Batch status failed: HTTP ${pollRes.status}`
      );
    }

    console.log(
      `[batch] poll ${poll}: status=${status.status} processed=${status.processedCount}/${status.itemCount} ok=${status.successCount} err=${status.errorCount}`
    );

    if (status.status === "completed" || status.status === "failed") {
      console.log("[batch] final:", JSON.stringify(status, null, 2));
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Batch polling timed out");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
