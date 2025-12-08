#!/usr/bin/env bun
/**
 * Real SGCTL mixed funding rehearsal (40% SGCTL + 60% GLW)
 * ------------------------------------------------------------------
 * - Seeds a fresh application directly in the database (foundation wallet)
 * - Calls the Hub API endpoints exactly like Control would:
 *      • POST /fractions/create-launchpad-presale
 *      • POST /applications/delegate-sgctl    (multiple times)
 *      • GET  /trigger-expire-fractions-cron  (presale + GLW expiration)
 *      • POST /applications/publish-application-to-auction
 * - Uses the real fraction pipeline (`recordFractionSplit`) for GLW sales
 * - Spins up a lightweight Control API stub on CONTROL_API_URL so Hub
 *   finalize/refund callbacks succeed without the real Control backend
 *
 * Usage:
 *   bun run scripts/simulate-sgctl-mixed-flow.ts [--mode=success|refund]
 *
 * Requirements:
 *   - Hub server running locally (default: http://localhost:3005)
 *   - Env vars set in BOTH the Hub server and this script:
 *       NEXTAUTH_SECRET
 *       FOUNDATION_HUB_MANAGER_WALLET
 *       GUARDED_API_KEY
 *       CONTROL_API_URL (set to http://localhost:<port> so the stub can bind)
 *       R2_NOT_ENCRYPTED_FILES_BUCKET_NAME (Hub needs this to create farms)
 *
 * Notes:
 *   - A fresh application is created every run to avoid clashing with real data.
 *   - The Control API stub only starts when CONTROL_API_URL points to localhost.
 *   - On success mode the Hub will finalize SGCTL and create a farm.
 *   - On refund mode the GLW fraction expires and SGCTL is refunded via stub.
 */

import http from "http";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";

import { db } from "../src/db/db";
import { forwarderAddresses } from "../src/constants/addresses";
import {
  Accounts,
  ApplicationPriceQuotes,
  applications,
  applicationsAuditFieldsCRS,
  applicationsEnquiryFieldsCRS,
  ApplicationsEncryptedMasterKeys,
  fractions,
  Gcas,
  RewardSplits,
  zones,
  users,
} from "../src/db/schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  RoundRobinStatusEnum,
} from "../src/types/api-types/Application";
import { FRACTION_STATUS } from "../src/constants/fractions";
import { recordFractionSplit } from "../src/db/mutations/fractions/createFraction";

const HUB_API_URL = process.env.HUB_API_URL || "http://localhost:3005";
const CONTROL_API_URL = process.env.CONTROL_API_URL;
const FOUNDATION_WALLET =
  forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase();
const NEXTAUTH_SECRET = requireEnv("NEXTAUTH_SECRET");
const GUARDED_API_KEY = requireEnv("GUARDED_API_KEY");

const DEFAULT_DEPOSIT_USD = 10_000;
const PRESALE_PERCENT = 0.4;
const DEFAULT_PRESALE_STEPS = Math.round(DEFAULT_DEPOSIT_USD * PRESALE_PERCENT);
const SGCTL_STEP_PRICE_ATOMIC = BigInt(1_000_000); // $1 in 6 decimals
const GLW_STEP_PRICE_ATOMIC = BigInt("1000000000000000000"); // 1 GLW
const USD_DECIMALS = BigInt(1_000_000);
const SCALE_18 = BigInt("1000000000000000000");

const SIM_APP_OWNER =
  "0x5252FdA14A149c01EA5A1D6514A9c1369E4C70b4".toLowerCase();
const SIM_GCA = "0x63a74612274FbC6ca3f7096586aF01Fd986d69cE".toLowerCase();
const SIM_PRICE_QUOTE_GCA =
  "0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd".toLowerCase();
const SIM_ZONE_ID = 2;
const SIM_AUDIT_DEVICE = {
  publicKey: "sim-device-001",
  shortId: "SIM001",
};
const SIM_REWARD_SPLITS = [
  {
    walletAddress: "0x34b50C3A7f004c65CEF59aa29cC9102C46d4c9bA".toLowerCase(),
    glowSplitPercent: "50",
    usdgSplitPercent: "10",
  },
  {
    walletAddress: "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70c8".toLowerCase(),
    glowSplitPercent: "40",
    usdgSplitPercent: "90",
  },
  {
    walletAddress: SIM_APP_OWNER,
    glowSplitPercent: "10",
    usdgSplitPercent: "0",
  },
];

const DELEGATOR_WALLETS = [
  "0xabc1230000000000000000000000000000000001",
  "0xdef4560000000000000000000000000000000002",
  "0x987fed0000000000000000000000000000000003",
  "0x654cba0000000000000000000000000000000004",
  "0x7777770000000000000000000000000000000005",
];
const GLW_BUYERS = [
  "0x1234500000000000000000000000000000000001",
  "0x1234500000000000000000000000000000000002",
  "0x1234500000000000000000000000000000000003",
];
const GLW_FRACTION_TOLERANCE_USD6 = 1000n;

type ScenarioName =
  | "mixed-success"
  | "refund"
  | "sgctl-only"
  | "zero-presale"
  | "multi-retry"
  | "validation";

interface GlwPlanPreset {
  mode: "success" | "refund";
  totalSteps: number;
  successBatches?: number[];
  failureBatches?: number[];
}

interface ScenarioPreset {
  key: ScenarioName;
  label: string;
  description: string;
  sgctlTotalSteps: number;
  sgctlDelegationAmounts: number[];
  expirePresaleBeforeGlw: boolean;
  glwPlan?: GlwPlanPreset;
  skipGlw?: boolean;
  special?: "multi-retry" | "validation";
}

interface DelegationPlan {
  wallet: string;
  amount: number;
}

interface DelegatePayload {
  applicationId: string;
  fractionId: string;
  amount: string;
  from: string;
  regionId: number;
  paymentDate: string;
}

interface ValidationResult {
  description: string;
  status: "pass" | "fail";
  detail: string;
}

interface FailureCase {
  description: string;
  execute: () => Promise<unknown>;
  expectSubstring?: string;
}

const SCENARIO_PRESETS: Record<ScenarioName, ScenarioPreset> = {
  "mixed-success": {
    key: "mixed-success",
    label: "40% SGCTL + 60% GLW (success)",
    description:
      "Baseline partial presale followed by a successful GLW round (doc scenario: Real-world 40/60).",
    sgctlTotalSteps: DEFAULT_PRESALE_STEPS,
    sgctlDelegationAmounts: [1000, 1500.05, 500, 500],
    expirePresaleBeforeGlw: true,
    glwPlan: {
      mode: "success",
      totalSteps: DEFAULT_DEPOSIT_USD - DEFAULT_PRESALE_STEPS,
      successBatches: [2000, 2000, 2500],
    },
  },
  refund: {
    key: "refund",
    label: "40% SGCTL + failing GLW (refund)",
    description:
      "Partial presale followed by an under-filled GLW fraction that expires and triggers refunds (doc scenario: Funding Failure).",
    sgctlTotalSteps: DEFAULT_PRESALE_STEPS,
    sgctlDelegationAmounts: [1000, 1500.05, 500, 500],
    expirePresaleBeforeGlw: true,
    glwPlan: {
      mode: "refund",
      totalSteps: DEFAULT_DEPOSIT_USD - DEFAULT_PRESALE_STEPS,
      failureBatches: [1000, 1000],
    },
  },
  "sgctl-only": {
    key: "sgctl-only",
    label: "100% SGCTL presale",
    description:
      "Presale alone covers the entire protocol deposit (doc scenarios: Happy Path + Presale Fully Funds).",
    sgctlTotalSteps: DEFAULT_DEPOSIT_USD,
    sgctlDelegationAmounts: [4000, 3000, 3000],
    expirePresaleBeforeGlw: false,
    skipGlw: true,
  },
  "zero-presale": {
    key: "zero-presale",
    label: "Zero presale fill",
    description:
      "No SGCTL sales; GLW raises the full deposit after Tuesday (doc scenario: Zero Fill Success Path).",
    sgctlTotalSteps: DEFAULT_DEPOSIT_USD,
    sgctlDelegationAmounts: [],
    expirePresaleBeforeGlw: true,
    glwPlan: {
      mode: "success",
      totalSteps: DEFAULT_DEPOSIT_USD,
      successBatches: [4000, 3000, 3000],
    },
  },
  "multi-retry": {
    key: "multi-retry",
    label: "Sequential GLW attempts",
    description:
      "Simulates the 'one active GLW' rule + retry workflow (doc scenario: Multi-Retry Path).",
    sgctlTotalSteps: DEFAULT_PRESALE_STEPS,
    sgctlDelegationAmounts: [1500, 1500, 1000],
    expirePresaleBeforeGlw: true,
    special: "multi-retry",
  },
  validation: {
    key: "validation",
    label: "Delegate guardrails",
    description:
      "Negative tests for /applications/delegate-sgctl (underpay, overpay, capacity, expiration, auth).",
    sgctlTotalSteps: 10,
    sgctlDelegationAmounts: [],
    expirePresaleBeforeGlw: false,
    special: "validation",
  },
};

interface CliOptions {
  scenario: ScenarioName;
}

interface HubClientOptions {
  bearerToken: string;
}

interface ControlApiStubResult {
  stop: () => Promise<void>;
  finalizeCalls: Array<Record<string, unknown>>;
  refundCalls: Array<Record<string, unknown>>;
}

interface SimulationArtifacts {
  applicationId: string;
  presaleFractionId: string;
  glwFractionId: string;
}

/**
 * Parses CLI flags (default mode: success).
 */
function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let scenario: ScenarioName = "mixed-success";

  for (const arg of args) {
    if (arg === "--refund") {
      scenario = "refund";
    } else if (arg.startsWith("--mode=")) {
      const value = arg.split("=")[1];
      if (value === "success") scenario = "mixed-success";
      if (value === "refund") scenario = "refund";
    } else if (arg.startsWith("--scenario=")) {
      const value = arg.split("=")[1] as ScenarioName;
      if (value && SCENARIO_PRESETS[value]) {
        scenario = value;
      }
    }
  }

  return { scenario };
}

/**
 * Ensures env var exists.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Formats USD for logs.
 */
function formatUsd(amount: number) {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function toAtomic(amount: number, decimals: number) {
  return BigInt(Math.round(amount * 10 ** decimals)).toString();
}

function toAtomicFromSteps(stepPrice: bigint, steps: number): string {
  return (stepPrice * BigInt(steps)).toString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(id: string) {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function buildDelegations(amounts: number[]): DelegationPlan[] {
  return amounts.map((amount, index) => ({
    wallet: DELEGATOR_WALLETS[index % DELEGATOR_WALLETS.length],
    amount,
  }));
}

function formatUsdFromAtomic(amount: bigint) {
  return formatUsd(Number(amount) / Number(USD_DECIMALS));
}

function formatGlwAmount(glwAtomic: bigint, precision = 4) {
  const whole = glwAtomic / SCALE_18;
  const fraction = glwAtomic % SCALE_18;
  const fractionStr = fraction
    .toString()
    .padStart(18, "0")
    .slice(0, precision)
    .replace(/0+$/, "");
  return fractionStr ? `${whole.toString()}.${fractionStr}` : whole.toString();
}

interface GlwStepPriceInput {
  remainingUsd: bigint;
  glwPriceUsd6: bigint;
  totalSteps: number;
  tolerance?: bigint;
}

function calculateGlwStepPriceAtomic({
  remainingUsd,
  glwPriceUsd6,
  totalSteps,
  tolerance = GLW_FRACTION_TOLERANCE_USD6,
}: GlwStepPriceInput) {
  if (remainingUsd <= 0n) {
    return 0n;
  }
  if (glwPriceUsd6 <= 0n) {
    throw new Error("GLW price quote missing");
  }
  if (totalSteps <= 0) {
    throw new Error("GLW total steps must be greater than zero");
  }

  const stepsBigInt = BigInt(totalSteps);
  const numerator = remainingUsd * SCALE_18;
  const denominator = glwPriceUsd6 * stepsBigInt;
  if (denominator === 0n) {
    throw new Error("Invalid GLW price denominator");
  }

  let stepPrice = numerator / denominator;
  if (numerator % denominator !== 0n) {
    stepPrice += 1n; // round up so we never underfund
  }

  const newFractionUsd = (stepPrice * stepsBigInt * glwPriceUsd6) / SCALE_18;
  const difference =
    newFractionUsd > remainingUsd
      ? newFractionUsd - remainingUsd
      : remainingUsd - newFractionUsd;

  if (difference > tolerance) {
    throw new Error(
      `Unable to compute GLW step price within tolerance (diff=${difference.toString()})`
    );
  }

  return stepPrice;
}

/**
 * Starts a very small Control API stub so Hub finalize/refund callbacks succeed.
 */
async function startControlApiStub(): Promise<ControlApiStubResult | null> {
  if (!CONTROL_API_URL) {
    console.warn("⚠️ CONTROL_API_URL is not set. Hub callbacks will fail.");
    return null;
  }

  const url = new URL(CONTROL_API_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    console.warn(
      `⚠️ CONTROL_API_URL (${CONTROL_API_URL}) is not localhost. Assuming a real Control API is available.`
    );
    return null;
  }

  const port = Number(url.port || 80);
  const finalizeCalls: Array<Record<string, unknown>> = [];
  const refundCalls: Array<Record<string, unknown>> = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString() || "{}";
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw);
      } catch (_) {}

      if (
        req.method === "POST" &&
        req.url?.startsWith("/delegate-sgctl/finalize")
      ) {
        finalizeCalls.push(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            fractionId: payload.fractionId,
            farmId: payload.farmId || `farm-${randomUUID().slice(0, 8)}`,
            processed: payload.processed || 1,
          })
        );
        return;
      }

      if (
        req.method === "POST" &&
        req.url?.startsWith("/delegate-sgctl/refund")
      ) {
        refundCalls.push(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            fractionId: payload.fractionId,
            processed: 1,
          })
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, url.hostname, () => resolve());
  });

  console.log(
    `🛰️  Control API stub listening at ${url.protocol}//${url.hostname}:${port}`
  );

  return {
    finalizeCalls,
    refundCalls,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Minimal HTTP client for the Hub API.
 */
class HubClient {
  constructor(private readonly options: HubClientOptions) {}

  private async request<T>(
    path: string,
    init: RequestInit & {
      requiresAuth?: boolean;
      requiresApiKey?: boolean;
    } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.headers as Record<string, string>),
    };

    if (init.requiresAuth) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
      headers["Content-Type"] = "application/json";
    }

    if (init.requiresApiKey) {
      headers["x-api-key"] = GUARDED_API_KEY;
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${HUB_API_URL}${path}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      throw new Error(
        `Request ${path} failed with ${response.status}: ${JSON.stringify(
          data
        )}`
      );
    }

    return data;
  }

  createLaunchpadPresale(body: {
    applicationId: string;
    sponsorSplitPercent: number;
    totalSteps: number;
    stepPrice: string;
  }) {
    return this.request<{ fractionId: string }>(
      "/fractions/create-launchpad-presale",
      {
        method: "POST",
        body: JSON.stringify(body),
        requiresAuth: true,
      }
    );
  }

  delegateSgctl(body: {
    applicationId: string;
    fractionId: string;
    amount: string;
    from: string;
    regionId: number;
    paymentDate: string;
  }) {
    return this.request<{ success: boolean }>("/applications/delegate-sgctl", {
      method: "POST",
      body: JSON.stringify(body),
      requiresApiKey: true,
    });
  }

  triggerExpireCron() {
    return this.request<{ message: string }>("/trigger-expire-fractions-cron", {
      method: "GET",
    });
  }

  publishGlw(body: {
    applicationId: string;
    sponsorSplitPercent: number;
    stepPrice: string;
    rewardScore: number;
    totalSteps: number;
  }) {
    return this.request<{ fractionId: string }>(
      "/applications/publish-application-to-auction",
      {
        method: "POST",
        body: JSON.stringify(body),
        requiresAuth: true,
      }
    );
  }
}

/**
 * Seeds a new application + dependencies directly in the DB.
 */
class SimulationSeeder {
  constructor(private readonly protocolDepositUsd: number) {}

  async seed(): Promise<{ applicationId: string }> {
    await this.ensureFoundationAccount();
    await this.ensureUserAccount(SIM_APP_OWNER, {
      firstName: "Sentinel",
      lastName: "Owner",
      email: "owner@example.com",
    });
    await this.ensureGcaAccount(SIM_GCA, "gca@example.com");
    await this.ensureUserAccount(SIM_PRICE_QUOTE_GCA, {
      firstName: "Price",
      lastName: "Signer",
      email: "price-signer@example.com",
    });
    await this.ensureZoneExists();
    const applicationId = await this.createApplication();
    await this.ensureEnquiryFields(applicationId);
    await this.ensureAuditFields(applicationId);
    await this.ensureEncryptedMasterKey(applicationId);
    await this.ensureRewardSplits(applicationId);
    await this.ensurePriceQuote(applicationId);
    return { applicationId };
  }

  private async ensureFoundationAccount() {
    const account = await db.query.Accounts.findFirst({
      where: eq(Accounts.id, FOUNDATION_WALLET),
    });
    if (!account) {
      await db.insert(Accounts).values({
        id: FOUNDATION_WALLET,
        role: "ADMIN",
        createdAt: new Date(),
        siweNonce: randomUUID().replace(/-/g, ""),
        salt: randomUUID().replace(/-/g, ""),
      });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, FOUNDATION_WALLET),
    });
    if (!user) {
      await db.insert(users).values({
        id: FOUNDATION_WALLET,
        createdAt: new Date(),
        firstName: "Foundation",
        lastName: "Manager",
        email: `foundation+${FOUNDATION_WALLET.slice(2, 8)}@example.org`,
        companyName: "Glow Foundation",
        companyAddress: "123 Solar Way",
        publicEncryptionKey: "sim-public-key",
        encryptedPrivateEncryptionKey: "sim-encrypted-private-key",
        isInstaller: false,
        contactType: "email",
        contactValue: "foundation@example.org",
      });
    }
  }

  private async ensureUserAccount(
    wallet: string,
    {
      firstName,
      lastName,
      email,
    }: { firstName: string; lastName: string; email: string }
  ) {
    const account = await db.query.Accounts.findFirst({
      where: eq(Accounts.id, wallet),
    });
    if (!account) {
      await db.insert(Accounts).values({
        id: wallet,
        role: "USER",
        createdAt: new Date(),
        siweNonce: randomUUID().replace(/-/g, ""),
        salt: randomUUID().replace(/-/g, ""),
      });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, wallet),
    });
    if (!user) {
      await db.insert(users).values({
        id: wallet,
        createdAt: new Date(),
        firstName,
        lastName,
        email,
        companyName: "Sentinel Energy",
        companyAddress: "Sentinel Address",
        publicEncryptionKey: "sim-public-key",
        encryptedPrivateEncryptionKey: "sim-encrypted-private-key",
        isInstaller: false,
        contactType: "email",
        contactValue: email,
      });
    }
  }

  private async ensureGcaAccount(wallet: string, email: string) {
    await this.ensureUserAccount(wallet, {
      firstName: "GCA",
      lastName: "Manager",
      email,
    });

    const gca = await db.query.Gcas.findFirst({
      where: eq(Gcas.id, wallet),
    });
    if (!gca) {
      await db.insert(Gcas).values({
        id: wallet,
        email,
        createdAt: new Date(),
        publicEncryptionKey: "sim-gca-public-key",
        encryptedPrivateEncryptionKey: "sim-gca-encrypted-key",
        serverUrls: ["https://simulator.glow"],
      });
    }
  }

  private async ensureZoneExists() {
    const zone = await db.query.zones.findFirst({
      where: eq(zones.id, SIM_ZONE_ID),
    });
    if (!zone) {
      throw new Error(
        `Zone ${SIM_ZONE_ID} not found. Please seed the Utah zone before running the simulation.`
      );
    }
  }

  private async createApplication() {
    const applicationId = randomUUID();
    const protocolFeeAtomic = BigInt(this.protocolDepositUsd * 1_000_000);

    await db.insert(applications).values({
      id: applicationId,
      userId: SIM_APP_OWNER,
      zoneId: SIM_ZONE_ID,
      createdAt: new Date(),
      currentStep: ApplicationSteps.payment,
      roundRobinStatus: RoundRobinStatusEnum.assigned,
      status: ApplicationStatusEnum.waitingForPayment,
      isCancelled: false,
      isDocumentsCorrupted: false,
      finalProtocolFee: protocolFeeAtomic,
      finalQuotePerWatt: "1.20",
      revisedKwhGeneratedPerYear: "7.90",
      revisedCostOfPowerPerKWh: "1.20",
      revisedEstimatedProtocolFees: "12668",
      paymentAmount: "0",
      paymentCurrency: "USDG",
      paymentEventType: "PayProtocolFee",
      allowedZones: [SIM_ZONE_ID],
      maxSplits: BigInt(0),
      gcaAddress: SIM_GCA,
      gcaAssignedTimestamp: new Date(),
      gcaAcceptanceTimestamp: new Date(),
      declarationOfIntentionSignature: "sentinel-signature",
      declarationOfIntentionSignatureDate: new Date(),
      installFinishedDate: new Date(),
      preInstallVisitDate: new Date(),
      preInstallVisitDateConfirmedTimestamp: new Date(),
      afterInstallVisitDate: new Date(),
      afterInstallVisitDateConfirmedTimestamp: new Date(),
    });

    return applicationId;
  }

  private async ensureEnquiryFields(applicationId: string) {
    const data = {
      applicationId,
      address: "sentinel-address",
      farmOwnerName: "sentinel-owner",
      farmOwnerEmail: "owner@example.com",
      farmOwnerPhone: "0000000000",
      lat: "41.94593",
      lng: "-111.83126",
      estimatedCostOfPowerPerKWh: "0.13",
      estimatedKWhGeneratedPerYear: "7.9",
      estimatedAdjustedWeeklyCredits: "0.12",
      enquiryEstimatedFees: "2216207000",
      enquiryEstimatedQuotePerWatt: "0.13",
      installerName: "sentinel-installer",
      installerCompanyName: "sentinel-company",
      installerEmail: "installer@example.com",
      installerPhone: "0000000000",
    };

    await db
      .insert(applicationsEnquiryFieldsCRS)
      .values(data)
      .onConflictDoUpdate({
        target: [applicationsEnquiryFieldsCRS.applicationId],
        set: { ...data, updatedAt: new Date() },
      });
  }

  private async ensureAuditFields(applicationId: string) {
    const device = {
      publicKey: `${SIM_AUDIT_DEVICE.publicKey}-${randomUUID().slice(0, 8)}`,
      shortId: `${SIM_AUDIT_DEVICE.shortId}-${randomUUID().slice(0, 4)}`,
    };

    await db
      .insert(applicationsAuditFieldsCRS)
      .values({
        applicationId,
        averageSunlightHoursPerDay: "4.74816609",
        adjustedWeeklyCarbonCredits: "0.11500758",
        weeklyTotalCarbonDebt: "0.04806365",
        netCarbonCreditEarningWeekly: "0.11500758",
        solarPanelsQuantity: 1,
        solarPanelsBrandAndModel: "sentinel-brand-model",
        solarPanelsWarranty: "10",
        finalEnergyCost: "12668",
        systemWattageOutput: "1000",
        ptoObtainedDate: new Date("2025-01-01"),
        locationWithoutPII: "sentinel-location",
        revisedInstallFinishedDate: new Date("2025-01-01"),
        devices: [device],
      })
      .onConflictDoUpdate({
        target: [applicationsAuditFieldsCRS.applicationId],
        set: {
          averageSunlightHoursPerDay: "4.74816609",
          adjustedWeeklyCarbonCredits: "0.11500758",
          weeklyTotalCarbonDebt: "0.04806365",
          netCarbonCreditEarningWeekly: "0.11500758",
          devices: [device],
          updatedAt: new Date(),
        },
      });
  }

  private async ensureEncryptedMasterKey(applicationId: string) {
    await db.insert(ApplicationsEncryptedMasterKeys).values({
      applicationId,
      userId: SIM_APP_OWNER,
      encryptedMasterKey: "sim-encrypted-master-key",
    });
  }

  private async ensureRewardSplits(applicationId: string) {
    await db.insert(RewardSplits).values(
      SIM_REWARD_SPLITS.map((split) => ({
        ...split,
        applicationId,
      }))
    );
  }

  private async ensurePriceQuote(applicationId: string) {
    await db.insert(ApplicationPriceQuotes).values({
      applicationId,
      gcaAddress: SIM_PRICE_QUOTE_GCA,
      prices: {
        GCTL: "1000000",
        GLW: "414652",
        USDC: "1000000",
        USDG: "1000000",
      },
      signature: `sim-${randomUUID()}`,
    });
  }
}

/**
 * Orchestrates the full scenario (success or refund).
 */
class ScenarioRunner {
  private readonly scenario: ScenarioName;
  private readonly preset: ScenarioPreset;
  private readonly scenarioLabel: string;
  private readonly scenarioDescription: string;
  private readonly shouldExpirePresaleBeforeGlw: boolean;
  private readonly skipGlw: boolean;
  private readonly isMultiRetry: boolean;
  private readonly bearerToken: string;
  private readonly hubClient: HubClient;
  private readonly protocolFeeUsd = BigInt(DEFAULT_DEPOSIT_USD) * USD_DECIMALS;

  private sgctlTotalSteps: number;
  private sgctlDelegations: DelegationPlan[];
  private glwPlan: GlwPlanPreset | undefined;
  private validationResults: ValidationResult[] = [];

  private applicationId!: string;
  private presaleFractionId!: string;
  private glwFractionId!: string;
  private glwStepPriceAtomic: bigint = GLW_STEP_PRICE_ATOMIC;
  private sgctlUsdRaised: bigint = 0n;
  private remainingUsd: bigint = this.protocolFeeUsd;
  private glwPriceUsd6: bigint = 0n;

  constructor(scenario: ScenarioName) {
    this.scenario = scenario;
    this.preset = SCENARIO_PRESETS[scenario];
    this.sgctlTotalSteps = this.preset.sgctlTotalSteps;
    this.sgctlDelegations = buildDelegations(
      this.preset.sgctlDelegationAmounts
    );
    this.glwPlan = this.preset.glwPlan;
    this.shouldExpirePresaleBeforeGlw = this.preset.expirePresaleBeforeGlw;
    this.skipGlw = Boolean(this.preset.skipGlw);
    this.isMultiRetry = this.preset.special === "multi-retry";
    this.scenarioLabel = this.preset.label;
    this.scenarioDescription = this.preset.description;

    this.bearerToken = jwt.sign(
      { userId: FOUNDATION_WALLET },
      NEXTAUTH_SECRET,
      {
        expiresIn: "15m",
      }
    );
    this.hubClient = new HubClient({ bearerToken: this.bearerToken });
  }

  async run(controlStub: ControlApiStubResult | null) {
    console.log("🚀 Bootstrapping simulation data…");
    console.log(`   • Scenario: ${this.scenarioLabel}`);
    console.log(`   • ${this.scenarioDescription}`);
    await this.seedApplication();

    if (this.isMultiRetry) {
      await this.runMultiRetryScenario(controlStub);
      return;
    }

    if (this.preset.special === "validation") {
      await this.runValidationScenario(controlStub);
      return;
    }

    await this.runStandardScenario(controlStub);
  }

  private async seedApplication() {
    const seeder = new SimulationSeeder(DEFAULT_DEPOSIT_USD);
    const { applicationId } = await seeder.seed();
    this.applicationId = applicationId;
    this.presaleFractionId = "";
    this.glwFractionId = "";
    this.sgctlUsdRaised = 0n;
    this.remainingUsd = this.protocolFeeUsd;
    console.log(`   • Application ID: ${applicationId}`);
  }

  private async runStandardScenario(controlStub: ControlApiStubResult | null) {
    await this.createPresale();

    if (this.sgctlDelegations.length > 0) {
      await this.delegateSgctl(this.sgctlDelegations);
    } else {
      console.log("\n2️⃣  Skipping SGCTL delegations (none configured)...");
    }

    await this.refreshFundingState();

    if (this.shouldExpirePresaleBeforeGlw && (this.glwPlan || !this.skipGlw)) {
      await this.expirePresale();
    }

    if (!this.glwPlan || this.skipGlw) {
      if (this.remainingUsd === 0n) {
        console.log(
          "\n✅ Protocol deposit fully funded via SGCTL. Waiting for farm creation…"
        );
        await this.waitForFarmCreation();
      } else {
        console.log(
          `\n⚠️ No GLW plan configured, remaining deficit: ${formatUsdFromAtomic(
            this.remainingUsd
          )}`
        );
      }
      await this.printSummary(controlStub);
      return;
    }

    if (this.remainingUsd <= 0n) {
      console.log(
        "   • Application already fully funded. Skipping GLW fraction."
      );
      await this.printSummary(controlStub);
      return;
    }

    await this.createGlwFraction(this.glwPlan.totalSteps);

    if (this.glwPlan.mode === "success" && this.glwPlan.successBatches) {
      await this.fillGlwFraction(this.glwPlan.successBatches);
      await this.waitForFarmCreation();
    } else if (this.glwPlan.mode === "refund" && this.glwPlan.failureBatches) {
      await this.partialGlwFillAndExpire(this.glwPlan.failureBatches);
    } else {
      throw new Error("Invalid GLW plan configuration");
    }

    await this.printSummary(controlStub);
  }

  private async runMultiRetryScenario(
    controlStub: ControlApiStubResult | null
  ) {
    console.log("\n🌀 Attempt #1 (expect refund)");
    await this.createPresale(DEFAULT_PRESALE_STEPS);
    await this.delegateSgctl(this.sgctlDelegations);
    await this.refreshFundingState();
    await this.expirePresale();

    const attemptSteps = DEFAULT_DEPOSIT_USD - DEFAULT_PRESALE_STEPS;
    await this.createGlwFraction(attemptSteps);

    console.log("\n🚫 Trying to publish a second GLW while one is active…");
    try {
      await this.hubClient.publishGlw({
        applicationId: this.applicationId,
        sponsorSplitPercent: 50,
        stepPrice: this.glwStepPriceAtomic.toString(),
        rewardScore: 100,
        totalSteps: attemptSteps,
      });
    } catch (error) {
      console.log(`   • Expected rejection: ${(error as Error).message}`);
    }

    await this.partialGlwFillAndExpire([1000, 1000]);

    console.log("\n🔄 Creating a fresh application for retry…");
    await this.seedApplication();
    this.sgctlTotalSteps = DEFAULT_PRESALE_STEPS;
    this.sgctlDelegations = buildDelegations([1000, 1500.05, 500, 500]);
    this.glwPlan = {
      mode: "success",
      totalSteps: DEFAULT_DEPOSIT_USD - DEFAULT_PRESALE_STEPS,
      successBatches: [2000, 2000, 2500],
    };

    await this.createPresale(this.sgctlTotalSteps);
    await this.delegateSgctl(this.sgctlDelegations);
    await this.refreshFundingState();
    await this.expirePresale();
    await this.createGlwFraction(this.glwPlan.totalSteps);
    await this.fillGlwFraction(this.glwPlan.successBatches!);
    await this.waitForFarmCreation();

    await this.printSummary(controlStub);
  }

  private async runValidationScenario(
    controlStub: ControlApiStubResult | null
  ) {
    console.log("\n🧪 Running delegate validation guardrails…");
    await this.createPresale(10);
    await this.refreshFundingState();

    await this.expectFailure({
      description: "Underpay (< step price)",
      execute: () =>
        this.hubClient.delegateSgctl(
          this.buildDelegatePayload({
            amount: toAtomic(0.5, 6),
          })
        ),
      expectSubstring: "minimum step price",
    });

    await this.expectFailure({
      description: "Overpay (>1% tolerance)",
      execute: () =>
        this.hubClient.delegateSgctl(
          this.buildDelegatePayload({
            amount: toAtomic(1.2, 6),
            from: DELEGATOR_WALLETS[1],
          })
        ),
      expectSubstring: "exceeds maximum allowed",
    });

    await this.hubClient.delegateSgctl(
      this.buildDelegatePayload({
        amount: toAtomic(6, 6),
        from: DELEGATOR_WALLETS[2],
      })
    );

    await this.expectFailure({
      description: "Exceed remaining steps",
      execute: () =>
        this.hubClient.delegateSgctl(
          this.buildDelegatePayload({
            amount: toAtomic(6, 6),
            from: DELEGATOR_WALLETS[3],
          })
        ),
      expectSubstring: "steps remaining",
    });

    await db
      .update(fractions)
      .set({
        expirationAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(fractions.id, this.presaleFractionId));
    await this.hubClient.triggerExpireCron();

    await this.expectFailure({
      description: "Expired fraction",
      execute: () =>
        this.hubClient.delegateSgctl(
          this.buildDelegatePayload({
            amount: toAtomic(1, 6),
            from: DELEGATOR_WALLETS[4],
          })
        ),
      expectSubstring: "Fraction has expired",
    });

    console.log("\n🔄 Resetting application for remaining tests…");
    await this.seedApplication();
    await this.createPresale(10);
    await this.refreshFundingState();

    const validationGlwSteps = DEFAULT_DEPOSIT_USD - this.sgctlTotalSteps;
    await this.createGlwFraction(validationGlwSteps);

    await this.expectFailure({
      description: "Wrong fraction type (GLW)",
      execute: () =>
        this.hubClient.delegateSgctl(
          this.buildDelegatePayload({
            fractionId: this.glwFractionId!,
            from: DELEGATOR_WALLETS[0],
          })
        ),
      expectSubstring: "launchpad-presale",
    });

    await this.expectFailure({
      description: "Missing API key",
      execute: () =>
        this.delegateWithoutApiKey(
          this.buildDelegatePayload({
            amount: toAtomic(1, 6),
            from: DELEGATOR_WALLETS[1],
          })
        ),
      expectSubstring: "API Key",
    });

    this.printValidationResults(controlStub);
  }

  private buildDelegatePayload(
    overrides: Partial<DelegatePayload> = {}
  ): DelegatePayload {
    if (!this.presaleFractionId && !overrides.fractionId) {
      throw new Error("No presale fraction available for validation test");
    }

    return {
      applicationId: this.applicationId,
      fractionId: overrides.fractionId || this.presaleFractionId,
      amount: overrides.amount || toAtomic(1, 6),
      from: overrides.from || DELEGATOR_WALLETS[0],
      regionId: overrides.regionId ?? 1,
      paymentDate: overrides.paymentDate || new Date().toISOString(),
    };
  }

  private async delegateWithoutApiKey(body: DelegatePayload) {
    const response = await fetch(`${HUB_API_URL}/applications/delegate-sgctl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      throw new Error("Request unexpectedly succeeded without API key");
    }

    const text = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status}: ${text || "API Key validation failure"}`
    );
  }

  private async expectFailure(testCase: FailureCase) {
    try {
      await testCase.execute();
      this.validationResults.push({
        description: testCase.description,
        status: "fail",
        detail: "Request unexpectedly succeeded",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const passed =
        !testCase.expectSubstring ||
        message.toLowerCase().includes(testCase.expectSubstring.toLowerCase());
      this.validationResults.push({
        description: testCase.description,
        status: passed ? "pass" : "fail",
        detail: message,
      });
    }
  }

  private printValidationResults(controlStub: ControlApiStubResult | null) {
    console.log("\n🧪 Validation Results");
    if (this.validationResults.length === 0) {
      console.log("No validation cases were executed.");
    } else {
      console.table(
        this.validationResults.map((result) => ({
          Case: result.description,
          Result: result.status.toUpperCase(),
          Detail: result.detail,
        }))
      );
    }

    if (controlStub) {
      console.log("\n🔁 Control API Stub Calls");
      console.table({
        finalize: controlStub.finalizeCalls.length,
        refund: controlStub.refundCalls.length,
      });
    } else {
      console.log(
        "\n🔁 Control API callbacks were sent to the configured endpoint."
      );
    }
  }

  private async createPresale(totalSteps = this.sgctlTotalSteps) {
    this.sgctlTotalSteps = totalSteps;
    console.log("\n1️⃣  Creating SGCTL presale via Hub API…");
    const response = await this.hubClient.createLaunchpadPresale({
      applicationId: this.applicationId,
      sponsorSplitPercent: 50,
      totalSteps,
      stepPrice: SGCTL_STEP_PRICE_ATOMIC.toString(),
    });
    this.presaleFractionId = response.fractionId;
    console.log(`   • Presale Fraction ID: ${this.presaleFractionId}`);
  }

  private async delegateSgctl(delegations: DelegationPlan[]) {
    if (delegations.length === 0) {
      return;
    }

    console.log("\n2️⃣  Delegating SGCTL (Control → Hub)…");
    for (const delegation of delegations) {
      await this.hubClient.delegateSgctl({
        applicationId: this.applicationId,
        fractionId: this.presaleFractionId,
        amount: toAtomic(delegation.amount, 6),
        from: delegation.wallet,
        regionId: 1,
        paymentDate: new Date().toISOString(),
      });
      console.log(
        `   • ${delegation.amount.toFixed(2)} SGCTL from ${short(
          delegation.wallet
        )}`
      );
    }
  }

  private async refreshFundingState() {
    console.log("\nℹ️  Recalculating funding state after presale delegations…");

    const [presale] = await db
      .select({
        stepPrice: fractions.stepPrice,
        splitsSold: fractions.splitsSold,
      })
      .from(fractions)
      .where(eq(fractions.id, this.presaleFractionId))
      .limit(1);

    const sgctlStepPrice = presale?.stepPrice ? BigInt(presale.stepPrice) : 0n;
    const sgctlStepsSold = BigInt(presale?.splitsSold ?? 0);
    this.sgctlUsdRaised = sgctlStepPrice * sgctlStepsSold;
    this.remainingUsd =
      this.protocolFeeUsd > this.sgctlUsdRaised
        ? this.protocolFeeUsd - this.sgctlUsdRaised
        : 0n;

    const priceQuote = await db
      .select({ prices: ApplicationPriceQuotes.prices })
      .from(ApplicationPriceQuotes)
      .where(eq(ApplicationPriceQuotes.applicationId, this.applicationId))
      .orderBy(desc(ApplicationPriceQuotes.createdAt))
      .limit(1);

    const glwPriceValue = priceQuote[0]?.prices?.GLW;
    if (!glwPriceValue) {
      throw new Error("GLW price quote missing for application");
    }
    this.glwPriceUsd6 = BigInt(glwPriceValue);

    if (this.remainingUsd > 0n) {
      const targetSteps =
        this.glwPlan?.totalSteps ?? DEFAULT_DEPOSIT_USD - this.sgctlTotalSteps;
      this.glwStepPriceAtomic = calculateGlwStepPriceAtomic({
        remainingUsd: this.remainingUsd,
        glwPriceUsd6: this.glwPriceUsd6,
        totalSteps: targetSteps,
      });
    } else {
      this.glwStepPriceAtomic = GLW_STEP_PRICE_ATOMIC;
    }

    console.log(
      `   • SGCTL raised: ${formatUsdFromAtomic(this.sgctlUsdRaised)}`
    );
    console.log(
      `   • Remaining deficit: ${formatUsdFromAtomic(this.remainingUsd)}`
    );
    console.log(
      `   • GLW price quote: ${formatUsdFromAtomic(this.glwPriceUsd6)} per GLW`
    );
    if (this.remainingUsd > 0n) {
      const stepUsd = (this.glwStepPriceAtomic * this.glwPriceUsd6) / SCALE_18;
      console.log(
        `   • GLW step price set to ${formatGlwAmount(
          this.glwStepPriceAtomic
        )} GLW (~${formatUsdFromAtomic(stepUsd)} per step)`
      );
    }
  }

  private async expirePresale() {
    console.log("\n3️⃣  Fast-forwarding to Tuesday noon (expire presale)…");
    await db
      .update(fractions)
      .set({
        expirationAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(fractions.id, this.presaleFractionId));
    await this.hubClient.triggerExpireCron();
    console.log("   • Presale status should now be EXPIRED");
  }

  private async createGlwFraction(totalSteps: number) {
    console.log("\n4️⃣  Publishing GLW fraction for remaining deficit…");
    if (this.remainingUsd <= 0n) {
      console.log(
        "   • Application already fully funded by SGCTL. Skipping GLW fraction."
      );
      return;
    }

    const remainingUsdDisplay = formatUsdFromAtomic(this.remainingUsd);
    console.log(`   • Remaining deficit: ${remainingUsdDisplay}`);
    console.log(
      `   • GLW total steps: ${totalSteps} | step price: ${formatGlwAmount(
        this.glwStepPriceAtomic
      )} GLW`
    );

    const response = await this.hubClient.publishGlw({
      applicationId: this.applicationId,
      sponsorSplitPercent: 50,
      stepPrice: this.glwStepPriceAtomic.toString(),
      rewardScore: 100,
      totalSteps,
    });
    this.glwFractionId = response.fractionId;
    console.log(`   • GLW Fraction ID: ${this.glwFractionId}`);

    await db
      .update(fractions)
      .set({
        status: FRACTION_STATUS.COMMITTED,
        isCommittedOnChain: true,
        committedAt: new Date(),
        txHash: `0xsim-${randomUUID().replace(/-/g, "")}`,
        updatedAt: new Date(),
        step: this.glwStepPriceAtomic.toString(),
        stepPrice: this.glwStepPriceAtomic.toString(),
      })
      .where(eq(fractions.id, this.glwFractionId));
  }

  private async fillGlwFraction(
    batches: number[],
    fractionId = this.glwFractionId
  ) {
    if (!fractionId) return;
    console.log("\n5️⃣  Simulating GLW on-chain fills (recordFractionSplit)…");
    for (const [index, steps] of batches.entries()) {
      await recordFractionSplit({
        fractionId,
        transactionHash: `0xglw-success-${index}-${randomUUID().slice(0, 8)}`,
        blockNumber: "0",
        logIndex: index,
        creator: FOUNDATION_WALLET,
        buyer: GLW_BUYERS[index % GLW_BUYERS.length],
        step: this.glwStepPriceAtomic.toString(),
        amount: toAtomicFromSteps(this.glwStepPriceAtomic, steps),
        stepsPurchased: steps,
        timestamp: Math.floor(Date.now() / 1000),
      });
      console.log(`   • ${steps} steps sold on-chain`);
    }
  }

  private async waitForFarmCreation() {
    console.log("\n6️⃣  Waiting for farm creation + SGCTL finalize callback…");
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const [application] = await db
        .select({
          farmId: applications.farmId,
        })
        .from(applications)
        .where(eq(applications.id, this.applicationId))
        .limit(1);

      if (application?.farmId) {
        console.log(`   • Farm created (ID: ${application.farmId})`);
        return;
      }

      await sleep(1000);
    }

    console.warn("   • Timed out waiting for farm creation");
  }

  private async partialGlwFillAndExpire(
    batches: number[],
    fractionId = this.glwFractionId
  ) {
    if (!fractionId) return;
    console.log("\n5️⃣  Partial GLW sales followed by expiration…");
    for (const [index, steps] of batches.entries()) {
      await recordFractionSplit({
        fractionId,
        transactionHash: `0xglw-refund-${index}-${randomUUID().slice(0, 8)}`,
        blockNumber: "0",
        logIndex: index,
        creator: FOUNDATION_WALLET,
        buyer: GLW_BUYERS[index % GLW_BUYERS.length],
        step: this.glwStepPriceAtomic.toString(),
        amount: toAtomicFromSteps(this.glwStepPriceAtomic, steps),
        stepsPurchased: steps,
        timestamp: Math.floor(Date.now() / 1000),
      });
      console.log(`   • ${steps} GLW steps sold`);
    }

    await db
      .update(fractions)
      .set({
        expirationAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(fractions.id, fractionId));
    await this.hubClient.triggerExpireCron();
    console.log("   • GLW fraction expired → refund should trigger");
  }

  private async printSummary(controlStub: ControlApiStubResult | null) {
    console.log("\n📊 Simulation Summary");
    const presale = this.presaleFractionId
      ? await db.query.fractions.findFirst({
          where: eq(fractions.id, this.presaleFractionId),
        })
      : null;
    const glw = this.glwFractionId
      ? await db.query.fractions.findFirst({
          where: eq(fractions.id, this.glwFractionId),
        })
      : null;
    const [application] = await db
      .select({
        farmId: applications.farmId,
      })
      .from(applications)
      .where(eq(applications.id, this.applicationId))
      .limit(1);

    console.table({
      Scenario: this.scenarioLabel,
      Application: this.applicationId,
      "Presale Status": presale?.status || "—",
      "GLW Status": glw?.status || "—",
      "GLW Splits Sold": glw?.splitsSold ?? "—",
      "Farm ID": application?.farmId || "—",
    });

    if (controlStub) {
      console.log("\n🔁 Control API Stub Calls");
      console.table({
        finalize: controlStub.finalizeCalls.length,
        refund: controlStub.refundCalls.length,
      });
    } else {
      console.log(
        "\n🔁 Control API callbacks were sent to the configured endpoint."
      );
    }
  }
}

async function main() {
  const options = parseArgs();
  const controlStub = await startControlApiStub();

  try {
    const runner = new ScenarioRunner(options.scenario);
    await runner.run(controlStub);
    await controlStub?.stop();
    process.exit(0);
  } catch (error) {
    await controlStub?.stop();
    console.error("❌ Simulation failed:", error);
    process.exit(1);
  }
}

main();
