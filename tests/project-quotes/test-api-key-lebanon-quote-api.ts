/**
 * Local test: API key auth for Lebanon single + batch quote endpoints
 *
 * Usage:
 *   bun run tests/project-quotes/test-api-key-lebanon-quote-api.ts
 *
 * Optional env:
 *   API_URL=http://localhost:3005
 *   ORG_NAME="Acme Lebanon Solar"
 *   ORG_EMAIL="dev@acme.example"
 *   BATCH_SIZE=10
 */

const API_URL = process.env.API_URL ?? "http://localhost:3005";
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? "5", 10);

async function main() {
  // ---- Regions (no auth)
  {
    const resp = await fetch(`${API_URL}/quotes/regions`);
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(json?.error || `Regions failed: HTTP ${resp.status}`);
    }
    const count = Array.isArray(json.regions) ? json.regions.length : 0;
    console.log("[lebanon-api-key] regions:", count);
  }

  const orgName = process.env.ORG_NAME ?? `local-lebanon-test-${Date.now()}`;
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
  console.log("[lebanon-api-key] created apiKey for org:", orgName);

  const base = {
    annualConsumptionMWh: "19.823456423076922",
    systemSizeKw: "18.96",
    latitude: "33.8938",
    longitude: "35.5018",
  };

  const createdQuoteIds: string[] = [];

  // ---- Single (Lebanon, JSON body, no utility bill)
  {
    const resp = await fetch(`${API_URL}/quotes/project/lebanon`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        ...base,
        metadata: "local-lebanon-api-key-single",
        isProjectCompleted: false,
      }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        json?.error || `Single Lebanon quote failed: HTTP ${resp.status}`
      );
    }
    const quoteId = json.quoteId as string;
    if (!quoteId)
      throw new Error("No quoteId returned by /quotes/project/lebanon");
    createdQuoteIds.push(quoteId);
    console.log("[lebanon-api-key] single quoteId:", quoteId);
    console.log(
      "[lebanon-api-key] single extraction:",
      JSON.stringify(json.extraction ?? null)
    );
    if (Number(json?.rates?.discountRate) !== 0.35) {
      throw new Error(
        `Expected discountRate 0.35, got ${String(json?.rates?.discountRate)}`
      );
    }
  }

  // ---- Batch (Lebanon, JSON body)
  {
    if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
      throw new Error("BATCH_SIZE must be a positive integer");
    }
    if (BATCH_SIZE > 100) {
      throw new Error("BATCH_SIZE must be <= 100");
    }

    const requests = Array.from({ length: BATCH_SIZE }).map((_, index) => ({
      ...base,
      metadata: `local-lebanon-api-key-batch-${index + 1}`,
      isProjectCompleted: false,
    }));

    const resp = await fetch(`${API_URL}/quotes/project/lebanon/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ requests }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        json?.error || `Lebanon batch submit failed: HTTP ${resp.status}`
      );
    }

    const results = json.results as
      | Array<
          | { index: number; success: true; quoteId: string }
          | { index: number; success: false; error: string }
        >
      | undefined;

    const successCount = Number(json.successCount ?? 0);
    const errorCount = Number(json.errorCount ?? 0);
    console.log(
      `[lebanon-api-key] batch: ok=${successCount} err=${errorCount} total=${json.itemCount}`
    );

    for (const item of results ?? []) {
      if (item.success) createdQuoteIds.push(item.quoteId);
      else console.warn(`[lebanon-api-key] batch item failed:`, item);
    }
  }

  // ---- Retrieve quotes for current API key, verify LB quoteIds are present
  {
    const resp = await fetch(`${API_URL}/quotes/project-quotes`, {
      headers: { "x-api-key": apiKey },
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        json?.error || `Get project-quotes failed: HTTP ${resp.status}`
      );
    }

    const quotes = Array.isArray(json.quotes) ? (json.quotes as any[]) : [];
    const lbQuotes = quotes.filter((q) => q?.regionCode === "LB");
    const found = new Set(lbQuotes.map((q) => String(q?.id ?? "")));

    const missing = createdQuoteIds.filter((id) => !found.has(id));
    console.log("[lebanon-api-key] total quotes returned:", quotes.length);
    console.log("[lebanon-api-key] LB quotes returned:", lbQuotes.length);

    if (missing.length) {
      throw new Error(
        `Some created quoteIds were not found via /quotes/project-quotes: ${missing.join(
          ", "
        )}`
      );
    }

    console.log(
      "[lebanon-api-key] verified quoteIds present:",
      createdQuoteIds.length
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
