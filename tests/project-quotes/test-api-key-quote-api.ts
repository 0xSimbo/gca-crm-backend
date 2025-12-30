/**
 * Local test: API key auth for single + batch quote endpoints
 *
 * Usage:
 *   bun run tests/project-quotes/test-api-key-quote-api.ts
 *
 * Optional env:
 *   API_URL=http://localhost:3005
 *   ORG_NAME="Acme Solar"
 *   ORG_EMAIL="dev@acme.example"
 *   BATCH_SIZE=10
 */

import { readFileSync } from "fs";

const API_URL = process.env.API_URL ?? "http://localhost:3005";
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? "5", 10);

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // ---- Regions (no auth)
  {
    const resp = await fetch(`${API_URL}/quotes/regions`);
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(json?.error || `Regions failed: HTTP ${resp.status}`);
    }
    const count = Array.isArray(json.regions) ? json.regions.length : 0;
    console.log("[api-key] regions:", count);
  }

  const orgName = process.env.ORG_NAME ?? `local-test-${Date.now()}`;
  const email = process.env.ORG_EMAIL ?? `local+${Date.now()}@example.com`;

  const createKeyResp = await fetch(`${API_URL}/quotes/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgName, email }),
  });
  const createKeyJson = await createKeyResp.json();
  if (!createKeyResp.ok) {
    throw new Error(
      createKeyJson?.error || `Create key failed: HTTP ${createKeyResp.status}`
    );
  }

  const apiKey = createKeyJson.apiKey as string;
  if (!apiKey) {
    throw new Error("No apiKey returned by /quotes/api-keys");
  }

  const base = {
    annualConsumptionMWh: "19.823456423076922",
    systemSizeKw: "18.96",
    latitude: "39.0707091494141",
    longitude: "-94.35609788750925",
  };

  const pdfPath = "./tests/project-quotes/required_first_utility_bill.pdf";
  const pdfBuffer = readFileSync(pdfPath);

  // ---- Single
  {
    const formData = new FormData();
    formData.append("annualConsumptionMWh", base.annualConsumptionMWh);
    formData.append("systemSizeKw", base.systemSizeKw);
    formData.append("latitude", base.latitude);
    formData.append("longitude", base.longitude);
    formData.append("metadata", "local-api-key-single");

    const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], {
      type: "application/pdf",
    });
    const pdfFile = new File([pdfBlob], "utility_bill.pdf", {
      type: "application/pdf",
    });
    formData.append("utilityBill", pdfFile);

    const resp = await fetch(`${API_URL}/quotes/project`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: formData,
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        json?.error || `Single quote failed: HTTP ${resp.status}`
      );
    }
    console.log("[api-key] single quoteId:", json.quoteId);
  }

  // ---- Batch
  {
    if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
      throw new Error("BATCH_SIZE must be a positive integer");
    }

    const requests = Array.from({ length: BATCH_SIZE }).map((_, index) => ({
      ...base,
      metadata: `local-api-key-batch-${index + 1}`,
    }));

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

    const resp = await fetch(`${API_URL}/quotes/project/batch`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: formData,
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        json?.error || `Batch submit failed: HTTP ${resp.status}`
      );
    }

    const batchId = json.batchId as string;
    if (!batchId) throw new Error("No batchId returned");

    const statusUrl = `${API_URL}/quotes/project/batch/${batchId}`;
    for (let poll = 1; poll <= 300; poll++) {
      const pollResp = await fetch(statusUrl, {
        headers: { "x-api-key": apiKey },
      });
      const status = await pollResp.json();
      if (!pollResp.ok) {
        throw new Error(
          status?.error || `Batch poll failed: HTTP ${pollResp.status}`
        );
      }

      console.log(
        `[api-key] poll ${poll}: status=${status.status} processed=${status.processedCount}/${status.itemCount} ok=${status.successCount} err=${status.errorCount}`
      );

      if (status.status === "completed" || status.status === "failed") {
        console.log("[api-key] final:", JSON.stringify(status, null, 2));
        break;
      }

      await sleep(2000);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
