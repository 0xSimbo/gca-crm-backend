import { beforeEach, describe, expect, it, mock } from "bun:test";
import jwt from "jsonwebtoken";
import { Elysia } from "elysia";

process.env.NEXTAUTH_SECRET ??= "__test_nextauth_secret__";

type ComputeArgs = {
  weeklyConsumptionMWh: number;
  systemSizeKw: number;
  electricityPricePerKwh: number;
  latitude: number;
  longitude: number;
  override?: {
    discountRate?: number;
    escalatorRate?: number;
    years?: number;
    carbonOffsetsPerMwh?: number;
  };
};

const calls = {
  countQuotesInLastHour: 0,
  getRegionCodeFromCoordinates: 0,
  extractElectricityPriceFromUtilityBill: 0,
  computeProjectQuote: 0,
  createProjectQuote: 0,
};

let lastComputeArgs: ComputeArgs | null = null;
let lastCreateQuoteArgs: any | null = null;

mock.module("../../src/db/queries/project-quotes/countQuotesInLastHour", () => ({
  countQuotesInLastHour: async () => {
    calls.countQuotesInLastHour++;
    return 0;
  },
}));

mock.module("../../src/routers/applications-router/helpers/mapStateToRegionCode", () => ({
  getRegionCodeFromCoordinates: async () => {
    calls.getRegionCodeFromCoordinates++;
    return "US-UT";
  },
}));

mock.module("../../src/routers/applications-router/helpers/extractElectricityPrice", () => ({
  extractElectricityPriceFromUtilityBill: async () => {
    calls.extractElectricityPriceFromUtilityBill++;
    return {
      result: {
        pricePerKwh: 0.12345,
        pricePerKwhLocal: 0.12345,
        currencyCode: "USD",
        confidence: 0.9,
        rationale: "__test_rationale__",
      },
      billUrl: "https://example.com/__test_bill__",
    };
  },
}));

mock.module("../../src/routers/applications-router/helpers/computeProjectQuote", () => ({
  computeProjectQuote: async (args: ComputeArgs) => {
    calls.computeProjectQuote++;
    lastComputeArgs = args;
    return {
      discountRate: args.override?.discountRate ?? 0.075,
      escalatorRate: args.override?.escalatorRate ?? 0.0331,
      years: args.override?.years ?? 30,
      protocolDepositUsd: 123,
      protocolDepositUsd6: "123000000",
      weeklyCredits: 1,
      weeklyDebt: 0.25,
      netWeeklyCc: 0.75,
      netCcPerMwh: 2,
      carbonOffsetsPerMwh: 0.5,
      uncertaintyApplied: 0.35,
      weeklyImpactAssetsWad: "1",
      efficiencyScore: 42,
      debugJson: { __test__: true },
    };
  },
}));

mock.module("../../src/db/mutations/project-quotes/createProjectQuote", () => ({
  createProjectQuote: async (data: any) => {
    calls.createProjectQuote++;
    lastCreateQuoteArgs = data;
    return {
      id: "__test_quote_id__",
      ...data,
    };
  },
}));

const { applicationsRouter } = await import(
  "../../src/routers/applications-router/applicationsRouter"
);

function createApp() {
  return new Elysia().use(applicationsRouter);
}

function makeJwt(userId: string) {
  const secret = process.env.NEXTAUTH_SECRET!;
  return jwt.sign({ userId }, secret, { expiresIn: "1h" });
}

function makePdfFile() {
  // Small sentinel blob, only the content-type and size are validated for this endpoint.
  const bytes = new TextEncoder().encode("%PDF-1.4\n% test\n");
  return new File([bytes], "bill.pdf", { type: "application/pdf" });
}

beforeEach(() => {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) {
    calls[k] = 0;
  }
  lastComputeArgs = null;
  lastCreateQuoteArgs = null;
});

describe("Project Quote (Bearer): Lebanon auto-detection", () => {
  it("routes Lebanon coordinates to fixed-rate logic (no region mapper, no bill extraction)", async () => {
    const app = createApp();

    const form = new FormData();
    form.append("annualConsumptionMWh", "312.7");
    form.append("systemSizeKw", "197.19");
    // Lebanon-ish coords (inside our bounding box)
    form.append("latitude", "34.01984196517197");
    form.append("longitude", "35.64853656288991");
    form.append("metadata", "HMC Cortbsoui Hospital");
    form.append("utilityBill", makePdfFile());

    const token = makeJwt("0x" + "1".repeat(40));
    const res = await app.handle(
      new Request("http://localhost/applications/project-quote", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
    );

    expect(res.status).toBe(200);
    const json: any = await res.json();

    expect(json.regionCode).toBe("LB");
    expect(json.extraction.utilityBillUrl).toBe("lebanon-fixed-rate");
    expect(json.extraction.electricityPricePerKwh).toBe(0.3474);
    expect(json.extraction.confidence).toBe(1);
    expect(json.rates.discountRate).toBe(0.35);
    expect(json.rates.escalatorRate).toBe(0.05);

    expect(calls.getRegionCodeFromCoordinates).toBe(0);
    expect(calls.extractElectricityPriceFromUtilityBill).toBe(0);

    expect(lastComputeArgs?.electricityPricePerKwh).toBe(0.3474);
    expect(lastComputeArgs?.override?.discountRate).toBe(0.35);
    expect(lastComputeArgs?.override?.escalatorRate).toBe(0.05);

    expect(lastCreateQuoteArgs?.regionCode).toBe("LB");
    expect(lastCreateQuoteArgs?.priceSource).toBe("blended");
    expect(lastCreateQuoteArgs?.utilityBillUrl).toBe("lebanon-fixed-rate");
    expect(lastCreateQuoteArgs?.priceConfidence).toBe("1");
  });
});

