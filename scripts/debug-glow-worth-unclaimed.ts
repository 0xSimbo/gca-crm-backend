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
const GLW_SEPOLIA = "0x2039161fcE4C8e5CF5FE64e17Fd290E8dFF3c9BD".toLowerCase();

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

  const startWeekRaw = getArgValue(argv, "--startWeek") ?? "99";
  const endWeekRaw = getArgValue(argv, "--endWeek") ?? "111";
  const startWeek = Number(startWeekRaw);
  const endWeek = Number(endWeekRaw);
  if (!Number.isFinite(startWeek) || !Number.isFinite(endWeek) || endWeek < startWeek) {
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
  if (rewards[0] && typeof rewards[0] === "object") {
    console.log(
      "weekly rewards keys (first row):",
      Object.keys(rewards[0]).sort()
    );
    console.log(
      "weekly rewards first row sample:",
      JSON.stringify(rewards[0], null, 2)
    );
  }

  const maxWeek = rewards.reduce((max, r) => {
    const w = Number(r?.weekNumber ?? -1);
    return Number.isFinite(w) && w > max ? w : max;
  }, -1);
  const minWeek = rewards.reduce((min, r) => {
    const w = Number(r?.weekNumber ?? -1);
    return Number.isFinite(w) && w >= 0 && w < min ? w : min;
  }, Number.POSITIVE_INFINITY);

  const UNCLAIMED_LAG_WEEKS = 3;
  const claimableEndWeek = maxWeek >= 0 ? maxWeek - UNCLAIMED_LAG_WEEKS : -1;
  console.log("minWeek:", Number.isFinite(minWeek) ? minWeek : null);
  console.log("maxWeek:", maxWeek);
  console.log("UNCLAIMED_LAG_WEEKS:", UNCLAIMED_LAG_WEEKS);
  console.log("claimableEndWeek:", claimableEndWeek);

  let claimableGlwWei = BigInt(0);
  let claimableGlwWei_alt_walletTotal = BigInt(0);
  let claimableGlwWei_alt_inflationOnly = BigInt(0);

  const claimableByWeek: Array<{
    weekNumber: number;
    glowInflationTotalWei: string;
    protocolDepositRewardsReceivedWei: string;
    walletTotalGlowInflationRewardWei: string;
    walletProtocolDepositFromLaunchpadWei: string;
    walletProtocolDepositFromMiningCenterWei: string;
  }> = [];

  for (const r of rewards) {
    const weekNumber = Number(r?.weekNumber ?? -1);
    if (!Number.isFinite(weekNumber)) continue;
    if (weekNumber > claimableEndWeek) continue;

    const glowInflationTotal = safeBigInt(r?.glowInflationTotal);
    const protocolDepositRewardsReceived = safeBigInt(
      r?.protocolDepositRewardsReceived
    );

    // Alternative field names we’ve seen in other Control API payloads.
    const walletTotalGlowInflationReward = safeBigInt(
      r?.walletTotalGlowInflationReward
    );
    const walletProtocolDepositFromLaunchpad = safeBigInt(
      r?.walletProtocolDepositFromLaunchpad
    );
    const walletProtocolDepositFromMiningCenter = safeBigInt(
      r?.walletProtocolDepositFromMiningCenter
    );

    claimableGlwWei += glowInflationTotal + protocolDepositRewardsReceived;
    claimableGlwWei_alt_walletTotal +=
      walletTotalGlowInflationReward +
      walletProtocolDepositFromLaunchpad +
      walletProtocolDepositFromMiningCenter;
    claimableGlwWei_alt_inflationOnly += glowInflationTotal;

    claimableByWeek.push({
      weekNumber,
      glowInflationTotalWei: glowInflationTotal.toString(),
      protocolDepositRewardsReceivedWei:
        protocolDepositRewardsReceived.toString(),
      walletTotalGlowInflationRewardWei:
        walletTotalGlowInflationReward.toString(),
      walletProtocolDepositFromLaunchpadWei:
        walletProtocolDepositFromLaunchpad.toString(),
      walletProtocolDepositFromMiningCenterWei:
        walletProtocolDepositFromMiningCenter.toString(),
    });
  }

  claimableByWeek.sort((a, b) => a.weekNumber - b.weekNumber);

  console.log("claimable rows counted:", claimableByWeek.length);
  console.log(
    "claimableGlwWei (glowInflationTotal + protocolDepositRewardsReceived):",
    claimableGlwWei.toString(),
    `(${formatUnits18(claimableGlwWei)} GLW)`
  );
  console.log(
    "claimableGlwWei_alt_walletTotal (walletTotalGlowInflationReward + walletProtocolDepositFrom*):",
    claimableGlwWei_alt_walletTotal.toString(),
    `(${formatUnits18(claimableGlwWei_alt_walletTotal)} GLW)`
  );

  // Print the last few claimable weeks (most relevant).
  console.log("");
  console.log("last 8 claimable weeks (raw fields):");
  for (const row of claimableByWeek.slice(-8)) {
    console.log(
      `- week ${row.weekNumber}: glowInflationTotal=${row.glowInflationTotalWei} protocolDepositRewardsReceived=${row.protocolDepositRewardsReceivedWei} walletTotalGlowInflationReward=${row.walletTotalGlowInflationRewardWei}`
    );
  }

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
  if (claims[0] && typeof claims[0] === "object") {
    console.log("claims keys (first row):", Object.keys(claims[0]).sort());
    console.log("claims first row sample:", JSON.stringify(claims[0], null, 2));
  }

  let claimedGlwWei_mainnet = BigInt(0);
  let claimedGlwWei_sepolia = BigInt(0);
  let claimedAnyWei = BigInt(0);
  let mainnetMatches = 0;
  let sepoliaMatches = 0;
  let claimedGlwWei_mainnet_beneficiaryOnly = BigInt(0);
  let claimedGlwWei_sepolia_beneficiaryOnly = BigInt(0);
  let beneficiaryMismatchCount = 0;
  let claimantMismatchCount = 0;
  let claimedAnyWei_beneficiaryOnly = BigInt(0);
  let minClaimTs = Number.POSITIVE_INFINITY;
  let maxClaimTs = -1;
  const amountsByNonceMainnet = new Map<string, bigint>();
  const nonceCountsMainnet = new Map<string, number>();
  const sourceTotalsMainnet = new Map<string, bigint>();
  const sourceCountsMainnet = new Map<string, number>();
  const topClaimsMainnet: Array<{
    amountWei: bigint;
    amountGlw: string;
    timestamp: number | null;
    source: string;
    nonce: string;
    txHash: string;
  }> = [];

  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    const amount = safeBigInt(c?.amount);
    const beneficiary = String(c?.wallet || "").toLowerCase();
    const claimant = String(c?.claimant || "").toLowerCase();
    const ts = Number(c?.timestamp ?? NaN);
    if (Number.isFinite(ts)) {
      if (ts < minClaimTs) minClaimTs = ts;
      if (ts > maxClaimTs) maxClaimTs = ts;
    }

    claimedAnyWei += amount;
    if (beneficiary === wallet) claimedAnyWei_beneficiaryOnly += amount;
    if (beneficiary && beneficiary !== wallet) beneficiaryMismatchCount++;
    if (claimant && claimant !== wallet) claimantMismatchCount++;

    if (token === GLW_MAINNET) {
      claimedGlwWei_mainnet += amount;
      mainnetMatches++;
      if (beneficiary === wallet)
        claimedGlwWei_mainnet_beneficiaryOnly += amount;
      const nonce = String(c?.nonce ?? "");
      if (nonce) {
        amountsByNonceMainnet.set(
          nonce,
          (amountsByNonceMainnet.get(nonce) || BigInt(0)) + amount
        );
        nonceCountsMainnet.set(nonce, (nonceCountsMainnet.get(nonce) || 0) + 1);
      }

      const source = String(c?.source ?? "unknown");
      sourceTotalsMainnet.set(
        source,
        (sourceTotalsMainnet.get(source) || BigInt(0)) + amount
      );
      sourceCountsMainnet.set(
        source,
        (sourceCountsMainnet.get(source) || 0) + 1
      );

      // Track top claim amounts for inspection.
      const txHash = String(c?.txHash ?? "");
      topClaimsMainnet.push({
        amountWei: amount,
        amountGlw: formatUnits18(amount),
        timestamp: Number.isFinite(ts) ? ts : null,
        source,
        nonce,
        txHash,
      });
    }
    if (token === GLW_SEPOLIA) {
      claimedGlwWei_sepolia += amount;
      sepoliaMatches++;
      if (beneficiary === wallet)
        claimedGlwWei_sepolia_beneficiaryOnly += amount;
    }
  }

  console.log("GLW mainnet token:", GLW_MAINNET);
  console.log("GLW sepolia token:", GLW_SEPOLIA);
  console.log(
    "claimedGlwWei_mainnet:",
    claimedGlwWei_mainnet.toString(),
    `(${formatUnits18(claimedGlwWei_mainnet)} GLW)`,
    "matches:",
    mainnetMatches
  );
  console.log(
    "claimedGlwWei_mainnet (beneficiary==wallet only):",
    claimedGlwWei_mainnet_beneficiaryOnly.toString(),
    `(${formatUnits18(claimedGlwWei_mainnet_beneficiaryOnly)} GLW)`
  );
  console.log(
    "claimedGlwWei_sepolia:",
    claimedGlwWei_sepolia.toString(),
    `(${formatUnits18(claimedGlwWei_sepolia)} GLW)`,
    "matches:",
    sepoliaMatches
  );
  console.log(
    "claimedGlwWei_sepolia (beneficiary==wallet only):",
    claimedGlwWei_sepolia_beneficiaryOnly.toString(),
    `(${formatUnits18(claimedGlwWei_sepolia_beneficiaryOnly)} GLW)`
  );
  console.log("claimedAnyWei (all tokens):", claimedAnyWei.toString());
  console.log(
    "claimedAnyWei (all tokens, beneficiary==wallet only):",
    claimedAnyWei_beneficiaryOnly.toString()
  );
  console.log(
    "claims where beneficiary(wallet) != requested wallet:",
    beneficiaryMismatchCount
  );
  console.log(
    "claims where claimant != requested wallet:",
    claimantMismatchCount
  );
  console.log(
    "claims timestamp range:",
    Number.isFinite(minClaimTs)
      ? new Date(minClaimTs * 1000).toISOString()
      : null,
    "→",
    maxClaimTs >= 0 ? new Date(maxClaimTs * 1000).toISOString() : null
  );

  const topNonces = Array.from(amountsByNonceMainnet.entries())
    .map(([nonce, amountWei]) => ({
      nonce,
      amountWei,
      count: nonceCountsMainnet.get(nonce) || 0,
    }))
    .sort((a, b) =>
      a.amountWei > b.amountWei ? -1 : a.amountWei < b.amountWei ? 1 : 0
    )
    .slice(0, 12);

  console.log("");
  console.log("top nonces by claimed GLW (mainnet token):");
  for (const n of topNonces) {
    console.log(
      `- nonce ${n.nonce}: ${formatUnits18(n.amountWei)} GLW (events=${
        n.count
      })`
    );
  }

  const sources = Array.from(sourceTotalsMainnet.entries())
    .map(([source, amountWei]) => ({
      source,
      amountWei,
      count: sourceCountsMainnet.get(source) || 0,
    }))
    .sort((a, b) =>
      a.amountWei > b.amountWei ? -1 : a.amountWei < b.amountWei ? 1 : 0
    );

  console.log("");
  console.log("claimed GLW by `source` (mainnet token):");
  for (const s of sources) {
    console.log(
      `- ${s.source}: ${formatUnits18(s.amountWei)} GLW (events=${s.count})`
    );
  }

  topClaimsMainnet.sort((a, b) =>
    a.amountWei > b.amountWei ? -1 : a.amountWei < b.amountWei ? 1 : 0
  );
  console.log("");
  console.log("top 12 claim events by amount (mainnet token):");
  for (const c of topClaimsMainnet.slice(0, 12)) {
    const tsLabel =
      c.timestamp != null
        ? new Date(c.timestamp * 1000).toISOString()
        : "unknown";
    console.log(
      `- ${c.amountGlw} GLW | source=${c.source} nonce=${
        c.nonce || "<empty>"
      } ts=${tsLabel} tx=${c.txHash || "<empty>"}`
    );
  }

  console.log("");
  console.log("---- Range-based epoch ledger (earned vs claimed by claim timestamp) ----");

  const earnedByEpoch = new Map<number, bigint>();
  for (const r of rewards) {
    const weekNumber = Number(r?.weekNumber ?? -1);
    if (!Number.isFinite(weekNumber)) continue;
    if (weekNumber < startWeek || weekNumber > endWeek) continue;
    const earnedWei =
      safeBigInt(r?.glowInflationTotal) +
      safeBigInt(r?.protocolDepositRewardsReceived);
    earnedByEpoch.set(weekNumber, earnedWei);
  }

  const claimedByEpoch = new Map<number, bigint>();
  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    if (token !== GLW_MAINNET) continue;
    const ts = Number(c?.timestamp ?? NaN);
    if (!Number.isFinite(ts)) continue;
    const weekNumber = getCurrentEpoch(ts);
    if (weekNumber < startWeek || weekNumber > endWeek) continue;
    const amount = safeBigInt(c?.amount);
    claimedByEpoch.set(
      weekNumber,
      (claimedByEpoch.get(weekNumber) || BigInt(0)) + amount
    );
  }

  let totalEarnedWei = BigInt(0);
  let totalClaimedWei = BigInt(0);
  let runningUnclaimedWei = BigInt(0);

  for (let w = startWeek; w <= endWeek; w++) {
    const earnedWei = earnedByEpoch.get(w) || BigInt(0);
    const claimedWei = claimedByEpoch.get(w) || BigInt(0);
    totalEarnedWei += earnedWei;
    totalClaimedWei += claimedWei;
    runningUnclaimedWei += earnedWei - claimedWei;
    console.log(
      `- week ${w}: earned=${formatUnits18(earnedWei)} claimed=${formatUnits18(
        claimedWei
      )} runningUnclaimed=${formatUnits18(runningUnclaimedWei)}`
    );
  }

  console.log("");
  console.log(
    `range totals (weeks ${startWeek}..${endWeek}): earned=${formatUnits18(
      totalEarnedWei
    )} claimed=${formatUnits18(totalClaimedWei)} net=${formatUnits18(
      totalEarnedWei - totalClaimedWei
    )}`
  );

  console.log("");
  console.log("---- Unclaimed computed ----");

  function clampToZero(x: bigint): bigint {
    return x > BigInt(0) ? x : BigInt(0);
  }

  const unclaimedUsingMainnetClaims = clampToZero(
    claimableGlwWei - claimedGlwWei_mainnet
  );
  const unclaimedUsingMainnetClaimsBeneficiaryOnly = clampToZero(
    claimableGlwWei - claimedGlwWei_mainnet_beneficiaryOnly
  );
  const unclaimedUsingSepoliaClaims = clampToZero(
    claimableGlwWei - claimedGlwWei_sepolia
  );

  console.log(
    "unclaimed (using claimableGlwWei and mainnet GLW claims):",
    unclaimedUsingMainnetClaims.toString(),
    `(${formatUnits18(unclaimedUsingMainnetClaims)} GLW)`
  );
  console.log(
    "unclaimed (using claimableGlwWei and mainnet GLW claims, beneficiary==wallet only):",
    unclaimedUsingMainnetClaimsBeneficiaryOnly.toString(),
    `(${formatUnits18(unclaimedUsingMainnetClaimsBeneficiaryOnly)} GLW)`
  );
  console.log(
    "unclaimed (using claimableGlwWei and sepolia GLW claims):",
    unclaimedUsingSepoliaClaims.toString(),
    `(${formatUnits18(unclaimedUsingSepoliaClaims)} GLW)`
  );
  console.log(
    "unclaimed (alt claimableGlwWei_alt_walletTotal - mainnet claims):",
    clampToZero(
      claimableGlwWei_alt_walletTotal - claimedGlwWei_mainnet
    ).toString(),
    `(${formatUnits18(
      clampToZero(claimableGlwWei_alt_walletTotal - claimedGlwWei_mainnet)
    )} GLW)`
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
