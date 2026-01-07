/**
 * Debug script: trace why `unclaimedGlwRewardsWei` is 0 for a wallet.
 *
 * Usage:
 *   CONTROL_API_URL=<control-api-base> bun run scripts/debug-glow-worth-unclaimed.ts \
 *     --wallet 0x77f41144e787cb8cd29a37413a71f53f92ee050c
 *
 * Optional:
 *   API_URL=http://localhost:3005
 *   CLAIMS_API_BASE_URL=https://glow-ponder-listener-2-production.up.railway.app
 *
 * Notes:
 * - `/impact/glow-worth` uses `getUnclaimedGlwRewardsWei()` which treats "unclaimed"
 *   as earned GLW minus claimed GLW **within the requested epoch range**.
 * - This script prints the raw payload shapes + a per-epoch ledger using
 *   `claim.timestamp -> epoch` (same math as glow-control's `getCurrentEpoch`).
 */

import { getCurrentEpoch } from "../src/utils/getProtocolWeek";

const DEFAULT_API_URL = "http://localhost:3005";
const DEFAULT_CLAIMS_API_BASE_URL =
  "https://glow-ponder-listener-2-production.up.railway.app";

const GLW_MAINNET = "0xf4fbC617A5733EAAF9af08E1Ab816B103388d8B6".toLowerCase();
const GENESIS_TIMESTAMP = 1700352000;

interface Args {
  wallet: string;
  startWeek: number;
  endWeek: number;
}

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseArgs(argv: string[]): Args {
  const wallet =
    getArgValue(argv, "--wallet") ??
    getArgValue(argv, "-w") ??
    "0x77f41144e787cb8cd29a37413a71f53f92ee050c";

  const startWeekRaw = getArgValue(argv, "--startWeek") ?? "97";
  const endWeekRaw = getArgValue(argv, "--endWeek") ?? "111";
  const startWeek = Number(startWeekRaw);
  const endWeek = Number(endWeekRaw);
  if (
    !Number.isFinite(startWeek) ||
    !Number.isFinite(endWeek) ||
    endWeek < startWeek
  ) {
    throw new Error(
      `Invalid week range: startWeek=${startWeekRaw} endWeek=${endWeekRaw}`
    );
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }

  return {
    wallet: wallet.toLowerCase(),
    startWeek: Math.trunc(startWeek),
    endWeek: Math.trunc(endWeek),
  };
}

function formatUnits18(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const s = abs.toString().padStart(19, "0");
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return BigInt(0);
  } catch {
    return BigInt(0);
  }
}

async function fetchJsonOrThrow(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text || "<empty>"}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text || "<empty>"}`);
  }
}

function getV2WeekFromNonce(nonce: unknown): number | null {
  // Next.js app treats week 97 as v2 nonce 0.
  const FIRST_V2_WEEK = 97;
  const n = Number(nonce);
  if (!Number.isFinite(n) || n < 0) return null;
  const week = FIRST_V2_WEEK + Math.trunc(n);
  return week >= FIRST_V2_WEEK ? week : null;
}

async function main() {
  const { wallet, startWeek, endWeek } = parseArgs(process.argv);
  const apiUrl = process.env.API_URL ?? DEFAULT_API_URL;
  const controlApiUrl = process.env.CONTROL_API_URL;
  const claimsBaseUrl =
    process.env.CLAIMS_API_BASE_URL ?? DEFAULT_CLAIMS_API_BASE_URL;

  if (!controlApiUrl) {
    throw new Error(
      "CONTROL_API_URL not configured. Example: CONTROL_API_URL=https://<control-api> bun run scripts/debug-glow-worth-unclaimed.ts"
    );
  }

  console.log("wallet:", wallet);
  console.log("API_URL:", apiUrl);
  console.log("CONTROL_API_URL:", controlApiUrl);
  console.log("CLAIMS_API_BASE_URL:", claimsBaseUrl);
  console.log("range:", { startWeek, endWeek });
  console.log("");

  // 0) Compare with backend endpoint result (optional sanity check).
  try {
    const url = new URL("/impact/glow-worth", apiUrl);
    url.searchParams.set("walletAddress", wallet);
    url.searchParams.set("startWeek", String(startWeek));
    url.searchParams.set("endWeek", String(endWeek));
    const glowWorth = await fetchJsonOrThrow(url.toString());
    console.log(
      `backend /impact/glow-worth (startWeek=${startWeek},endWeek=${endWeek}):`
    );
    console.log(JSON.stringify(glowWorth, null, 2));
  } catch (error) {
    console.log("backend /impact/glow-worth: FAILED");
    console.log(String(error));
  }

  console.log("");
  console.log("---- Control API weekly rewards (claimable) ----");

  const weeklyUrl = new URL(
    `/wallets/address/${wallet}/weekly-rewards`,
    controlApiUrl
  );
  weeklyUrl.searchParams.set("paymentCurrency", "GLW");
  weeklyUrl.searchParams.set("limit", "520");

  const weeklyData = await fetchJsonOrThrow(weeklyUrl.toString());
  const rewards: any[] = Array.isArray(weeklyData?.rewards)
    ? weeklyData.rewards
    : [];

  console.log("weekly rewards rows:", rewards.length);

  const maxWeek = rewards.reduce((max, r) => {
    const w = Number(r?.weekNumber ?? -1);
    return Number.isFinite(w) && w > max ? w : max;
  }, -1);

  console.log("maxWeek:", maxWeek);

  console.log("");
  console.log("---- Claims API (claimed) ----");

  const claimsUrl = new URL(`/rewards/claims/${wallet}`, claimsBaseUrl);
  claimsUrl.searchParams.set("limit", "5000");
  const claimsData = await fetchJsonOrThrow(claimsUrl.toString());

  console.log("claims indexingComplete:", claimsData?.indexingComplete);
  const claims: any[] = Array.isArray(claimsData?.claims)
    ? claimsData.claims
    : [];
  console.log("claims rows:", claims.length);

  const rewardTimeline = {
    inflation: new Map<number, bigint>(),
    pd: new Map<number, bigint>(),
  };

  for (const r of rewards) {
    const week = Number(r.weekNumber);
    if (!Number.isFinite(week)) continue;
    const inflation = safeBigInt(r.glowInflationTotal);
    if (inflation > 0n) rewardTimeline.inflation.set(week, inflation);

    const pdRaw = safeBigInt(r.protocolDepositRewardsReceived);
    // Protocol deposit is usually GLW if paymentCurrency=GLW was requested
    if (pdRaw > 0n) rewardTimeline.pd.set(week, pdRaw);
  }

  // Claim data: week -> claimTimestamp
  // Filter out claims from before Week 97 (v2 system start)
  const WEEK_97_START_TIMESTAMP = GENESIS_TIMESTAMP + 97 * 604800;
  const claimPdData = new Map<number, number>();
  const claimInflationData = new Map<number, number>();
  const AMOUNT_MATCH_EPSILON_WEI = BigInt(10_000_000);

  // 1. PD claims (deterministic from nonce)
  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    if (token !== GLW_MAINNET) continue;
    const timestamp = Number(c?.timestamp);
    if (timestamp < WEEK_97_START_TIMESTAMP) continue;
    const source = String(c?.source || "");
    if (source !== "rewardsKernel") continue;
    const week = getV2WeekFromNonce(c?.nonce);
    if (week != null && week >= 97) claimPdData.set(week, timestamp);
  }

  // 2. Inflation claims (inferred from transfer amounts)
  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    if (token !== GLW_MAINNET) continue;
    const timestamp = Number(c?.timestamp);
    if (timestamp < WEEK_97_START_TIMESTAMP) continue;
    const source = String(c?.source || "");
    if (source !== "minerPool") continue;

    const amountWei = safeBigInt(c?.amount);
    let bestWeek: number | null = null;
    let bestDiff: bigint | null = null;
    let secondBestDiff: bigint | null = null;

    for (const [week, inflationWei] of rewardTimeline.inflation) {
      if (week < 97) continue;
      const diff =
        amountWei >= inflationWei
          ? amountWei - inflationWei
          : inflationWei - amountWei;
      if (bestDiff == null || diff < bestDiff) {
        secondBestDiff = bestDiff;
        bestDiff = diff;
        bestWeek = week;
        continue;
      }
      if (secondBestDiff == null || diff < secondBestDiff)
        secondBestDiff = diff;
    }

    if (
      bestWeek != null &&
      bestDiff != null &&
      bestDiff <= AMOUNT_MATCH_EPSILON_WEI
    ) {
      // Disambiguate: only if second best is not also within epsilon
      if (secondBestDiff == null || secondBestDiff > AMOUNT_MATCH_EPSILON_WEI) {
        claimInflationData.set(bestWeek, timestamp);
      }
    }
  }

  console.log("");
  console.log("---- Detected Claims ----");
  console.log(
    `PD Claims (from RewardsKernel nonce): ${claimPdData.size} weeks`
  );
  for (const [week, ts] of claimPdData) {
    console.log(
      `  - Week ${week}: claimed at ${new Date(ts * 1000).toISOString()}`
    );
  }
  console.log(
    `Inflation Claims (inferred from MinerPool amounts): ${claimInflationData.size} weeks`
  );
  for (const [week, ts] of claimInflationData) {
    console.log(
      `  - Week ${week}: claimed at ${new Date(ts * 1000).toISOString()}`
    );
  }

  console.log("");
  console.log(
    "---- Historical Unclaimed Ledger (New Logic Reconstructed) ----"
  );
  console.log(
    "This ledgers simulates the Glow Worth calculation for each week."
  );
  console.log(
    "Note: Claims made today should NOT affect the unclaimed balance of past weeks."
  );
  console.log("");

  let totalEarnedWeiRange = BigInt(0);

  for (let w = startWeek; w <= endWeek; w++) {
    const weekEndTimestamp = GENESIS_TIMESTAMP + (w + 1) * 604800;
    const inflationClaimableUpToWeek = w - 3;
    const pdClaimableUpToWeek = w - 4;

    let historicalUnclaimedWei = 0n;
    let inflationUnclaimedAtTimeW = 0n;
    let pdUnclaimedAtTimeW = 0n;

    // Sum unclaimed inflation (using inferred timestamps)
    for (const [rw, amount] of rewardTimeline.inflation) {
      if (rw <= inflationClaimableUpToWeek) {
        const claimTimestamp = claimInflationData.get(rw);
        // If never claimed OR claimed AFTER this week's end -> It was unclaimed at this week
        if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
          inflationUnclaimedAtTimeW += amount;
          historicalUnclaimedWei += amount;
        }
      }
    }

    // Sum unclaimed PD
    for (const [rw, amount] of rewardTimeline.pd) {
      if (rw <= pdClaimableUpToWeek) {
        const claimTimestamp = claimPdData.get(rw);
        // If never claimed OR claimed AFTER this week's end -> It was unclaimed AT THAT TIME
        if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
          pdUnclaimedAtTimeW += amount;
          historicalUnclaimedWei += amount;
        }
      }
    }

    console.log(
      `- Week ${String(w).padStart(3)} | Unclaimed: ${formatUnits18(
        historicalUnclaimedWei
      ).padStart(12)} GLW | (Inflation: ${formatUnits18(
        inflationUnclaimedAtTimeW
      )} GLW, PD: ${formatUnits18(pdUnclaimedAtTimeW)} GLW)`
    );
  }

  console.log("");
  console.log("---- Current Snapshot Totals ----");
  const nowSec = Math.floor(Date.now() / 1000);
  const currentThresholdWeek = Math.min(
    getCurrentEpoch(nowSec) - 3,
    getCurrentEpoch(nowSec) - 4
  );

  let currentTotalUnclaimedWei = 0n;
  for (const [rw, amount] of rewardTimeline.inflation) {
    if (rw <= currentThresholdWeek && !claimInflationData.has(rw))
      currentTotalUnclaimedWei += amount;
  }
  for (const [rw, amount] of rewardTimeline.pd) {
    if (rw <= currentThresholdWeek && !claimPdData.has(rw))
      currentTotalUnclaimedWei += amount;
  }

  console.log(
    `Current Unclaimed (Lagged): ${formatUnits18(currentTotalUnclaimedWei)} GLW`
  );
  console.log(
    `Total Inflation Earned: ${formatUnits18(
      Array.from(rewardTimeline.inflation.values()).reduce((a, b) => a + b, 0n)
    )} GLW`
  );
  console.log(
    `Total PD Earned:        ${formatUnits18(
      Array.from(rewardTimeline.pd.values()).reduce((a, b) => a + b, 0n)
    )} GLW`
  );
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("debug-glow-worth-unclaimed FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();
