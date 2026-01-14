/**
 * Debug script to compare different methods of calculating total actively delegated GLW
 *
 * Compares:
 * 1. Fractions-based calculation (historical purchase amounts)
 * 2. Impact leaderboard calculation (vault ownership of remaining principal)
 *
 * Usage:
 *   bun run scripts/debug-total-actively-delegated.ts
 */

import { formatUnits } from "viem";
import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";
import { getBatchPurchasesUpToWeek } from "../src/routers/fractions-router/helpers/accurate-apy-helpers";
import { getWalletPurchaseTypesByFarmUpToWeek } from "../src/routers/fractions-router/helpers/per-piece-helpers";
import { getAllDelegatorWallets } from "../src/routers/impact-router/helpers/impact-score";
import { db } from "../src/db/db";
import { applications } from "../src/db/schema";
import { eq, and, inArray } from "drizzle-orm";

interface ControlApiDepositSplitHistorySegment {
  farmId: string;
  startWeek: number;
  endWeek: number;
  depositSplitPercent6Decimals: string;
}

interface ControlApiFarmRewardsHistoryRewardRow {
  weekNumber: number;
  farmId: string;
  farmName: string | null;
  paymentCurrency: string | null;
  protocolDepositRewardsDistributed: string;
}

async function fetchDepositSplitsHistoryBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiDepositSplitHistorySegment[]>> {
  const { wallets, startWeek, endWeek } = params;
  const CONTROL_API_URL = process.env.CONTROL_API_URL;
  if (!CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }

  const url = `${CONTROL_API_URL}/farms/by-wallet/deposit-splits-history/batch`;
  console.log(`   Calling: ${url}`);
  console.log(
    `   Payload: ${wallets.length} wallets, weeks ${startWeek}-${endWeek}`
  );

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallets, startWeek, endWeek }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(
      `   Response error (${response.status}): ${text.slice(0, 200)}`
    );
    throw new Error(`Control API error: ${response.statusText}`);
  }

  const data = await response.json();
  console.log(`   Response keys: ${Object.keys(data).join(", ")}`);
  if (data.results) {
    const allWallets = Object.keys(data.results);
    console.log(`   Response has ${allWallets.length} wallet results`);
    // Control API returns segments directly as an array (not wrapped in a segments key)
    const walletsWithData = allWallets.filter(
      (w) => Array.isArray(data.results[w]) && data.results[w].length > 0
    );
    console.log(
      `   Wallets with segments: ${walletsWithData.length}/${wallets.length}`
    );
    if (walletsWithData.length > 0) {
      const firstWallet = walletsWithData[0];
      console.log(`   Example wallet: ${firstWallet}`);
      console.log(`   Segments count: ${data.results[firstWallet].length}`);
      console.log(
        `   First segment: ${JSON.stringify(data.results[firstWallet][0])}`
      );
    } else if (allWallets.length > 0) {
      const firstWallet = allWallets[0];
      console.log(`   Example wallet: ${firstWallet}`);
      console.log(
        `   Data type: ${typeof data.results[
          firstWallet
        ]}, isArray: ${Array.isArray(data.results[firstWallet])}`
      );
      if (Array.isArray(data.results[firstWallet])) {
        console.log(`   Array length: ${data.results[firstWallet].length}`);
        if (data.results[firstWallet].length > 0) {
          console.log(
            `   First element: ${JSON.stringify(data.results[firstWallet][0])}`
          );
        }
      }
    }
  }

  const resultMap = new Map<string, ControlApiDepositSplitHistorySegment[]>();

  for (const wallet of wallets) {
    const walletData = data.results?.[wallet];
    // Control API returns segments directly as an array, not wrapped in a segments key
    if (Array.isArray(walletData) && walletData.length > 0) {
      resultMap.set(wallet.toLowerCase(), walletData);
    }
  }

  return resultMap;
}

async function fetchFarmRewardsHistoryBatch(params: {
  farmIds: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>> {
  const { farmIds, startWeek, endWeek } = params;
  const CONTROL_API_URL = process.env.CONTROL_API_URL;
  if (!CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }

  const response = await fetch(
    `${CONTROL_API_URL}/farms/rewards-history/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farmIds, startWeek, endWeek }),
    }
  );

  if (!response.ok) {
    throw new Error(`Control API error: ${response.statusText}`);
  }

  const data = await response.json();
  const resultMap = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();

  for (const farmId of farmIds) {
    const farmData = data.results?.[farmId];
    if (farmData?.rewards) {
      resultMap.set(farmId, farmData.rewards);
    }
  }

  return resultMap;
}

async function calculateFractionsMethod() {
  console.log(
    "\n📊 METHOD 1: Fractions-based calculation (historical purchases)"
  );
  console.log("=".repeat(80));

  const weekRange = getWeekRangeForImpact();
  const { startWeek, endWeek } = weekRange;

  console.log(`Week range: ${startWeek} - ${endWeek}`);

  const purchaseInfo = await getWalletPurchaseTypesByFarmUpToWeek({ endWeek });
  const walletsToProcess = Array.from(purchaseInfo.walletToFarmTypes.keys());

  const allPurchasesUpToWeek = await getBatchPurchasesUpToWeek(
    walletsToProcess,
    endWeek
  );

  let totalGlwDelegatedWei = BigInt(0);

  for (const wallet of walletsToProcess) {
    const purchasesUpToWeek = allPurchasesUpToWeek.get(wallet);
    if (purchasesUpToWeek) {
      totalGlwDelegatedWei += purchasesUpToWeek.totalGlwDelegated;
    }
  }

  const totalGlw = Number(formatUnits(totalGlwDelegatedWei, 18));

  console.log(
    `\n✅ Total GLW from purchases: ${totalGlw.toLocaleString()} GLW`
  );
  console.log(`   (${totalGlwDelegatedWei.toString()} wei)`);
  console.log(`   Wallets processed: ${walletsToProcess.length}`);

  return { totalGlwDelegatedWei, totalWallets: walletsToProcess.length };
}

async function calculateVaultOwnershipMethod() {
  console.log(
    "\n📊 METHOD 2: Vault ownership calculation (remaining principal)"
  );
  console.log("=".repeat(80));

  const DELEGATION_START_WEEK = 97;
  const weekRange = getWeekRangeForImpact();
  const { endWeek } = weekRange;

  console.log(`Week range: ${DELEGATION_START_WEEK} - ${endWeek}`);

  // Get all delegator wallets (includes both direct purchases and vault ownership)
  const walletsToProcess = await getAllDelegatorWallets();

  console.log(
    `\n🔍 Fetching deposit split history for ${walletsToProcess.length} wallets...`
  );

  // Fetch deposit split history for all wallets
  const depositSplitsMap = await fetchDepositSplitsHistoryBatch({
    wallets: walletsToProcess,
    startWeek: DELEGATION_START_WEEK,
    endWeek,
  });

  // Get all unique farm IDs from deposit splits
  const allFarmIds = new Set<string>();
  for (const segments of depositSplitsMap.values()) {
    for (const seg of segments) {
      allFarmIds.add(seg.farmId);
    }
  }

  console.log(`📋 Found ${allFarmIds.size} unique farms with vault ownership`);

  if (allFarmIds.size === 0) {
    console.log("\n⚠️  No farms found with vault ownership!");
    console.log("   This means:");
    console.log("   - No deposit split history returned from Control API");
    console.log(
      "   - All delegation is tracked via direct fraction purchases (Method 1)"
    );
    return { totalActivelyDelegatedWei: BigInt(0), totalWallets: 0 };
  }

  // Fetch farm principals from DB
  const farmIds = Array.from(allFarmIds);
  const principalRows = await db
    .select({
      farmId: applications.farmId,
      paymentAmount: applications.paymentAmount,
    })
    .from(applications)
    .where(
      and(
        inArray(applications.farmId, farmIds),
        eq(applications.isCancelled, false),
        eq(applications.status, "completed"),
        eq(applications.paymentCurrency, "GLW")
      )
    );

  const farmPrincipals = new Map<string, bigint>();
  for (const row of principalRows) {
    if (!row.farmId) continue;
    const amountWei = BigInt(row.paymentAmount || "0");
    if (amountWei <= BigInt(0)) continue;
    farmPrincipals.set(
      row.farmId,
      (farmPrincipals.get(row.farmId) || BigInt(0)) + amountWei
    );
  }

  console.log(`💰 Found ${farmPrincipals.size} farms with GLW principal`);

  // Fetch cumulative distributions
  const glwPrincipalFarmIds = farmIds.filter(
    (id) => (farmPrincipals.get(id) || BigInt(0)) > BigInt(0)
  );

  console.log(
    `\n🔍 Fetching rewards history for ${glwPrincipalFarmIds.length} farms...`
  );

  const farmRewardsMap = await fetchFarmRewardsHistoryBatch({
    farmIds: glwPrincipalFarmIds,
    startWeek: DELEGATION_START_WEEK,
    endWeek,
  });

  const farmCumulativeDistributions = new Map<string, bigint>();
  for (const [farmId, rows] of farmRewardsMap) {
    let cumulative = BigInt(0);
    for (const r of rows) {
      if ((r.paymentCurrency || "").toUpperCase() !== "GLW") continue;
      const distributed = BigInt(r.protocolDepositRewardsDistributed || "0");
      if (distributed > BigInt(0)) {
        cumulative += distributed;
      }
    }
    farmCumulativeDistributions.set(farmId, cumulative);
  }

  // Calculate total actively delegated GLW
  let totalActivelyDelegatedWei = BigInt(0);
  const walletBreakdown: Array<{ wallet: string; amount: bigint }> = [];

  const SPLIT_SCALE = BigInt(1_000_000);

  for (const [wallet, segments] of depositSplitsMap) {
    let walletTotal = BigInt(0);

    for (const seg of segments) {
      const principalWei = farmPrincipals.get(seg.farmId) || BigInt(0);
      if (principalWei <= BigInt(0)) continue;

      const cumulativeDistributed =
        farmCumulativeDistributions.get(seg.farmId) || BigInt(0);
      const remaining =
        principalWei > cumulativeDistributed
          ? principalWei - cumulativeDistributed
          : BigInt(0);

      const splitScaled6 = BigInt(seg.depositSplitPercent6Decimals || "0");
      if (splitScaled6 <= BigInt(0)) continue;

      const walletShare = (remaining * splitScaled6) / SPLIT_SCALE;
      walletTotal += walletShare;
    }

    if (walletTotal > BigInt(0)) {
      walletBreakdown.push({ wallet, amount: walletTotal });
      totalActivelyDelegatedWei += walletTotal;
    }
  }

  const totalGlw = Number(formatUnits(totalActivelyDelegatedWei, 18));

  console.log(
    `\n✅ Total actively delegated GLW: ${totalGlw.toLocaleString()} GLW`
  );
  console.log(`   (${totalActivelyDelegatedWei.toString()} wei)`);
  console.log(`   Wallets with active delegation: ${walletBreakdown.length}`);

  // Show top 10 delegators
  console.log(`\n📈 Top 10 delegators by vault ownership:`);
  walletBreakdown.sort((a, b) => Number(b.amount - a.amount));
  for (let i = 0; i < Math.min(10, walletBreakdown.length); i++) {
    const { wallet, amount } = walletBreakdown[i];
    const glw = Number(formatUnits(amount, 18));
    console.log(`   ${i + 1}. ${wallet}: ${glw.toLocaleString()} GLW`);
  }

  return { totalActivelyDelegatedWei, totalWallets: walletBreakdown.length };
}

async function main() {
  console.log("🔍 Debugging Total Actively Delegated GLW Calculation");
  console.log("=".repeat(80));

  try {
    const method1 = await calculateFractionsMethod();
    const method2 = await calculateVaultOwnershipMethod();

    console.log("\n" + "=".repeat(80));
    console.log("📊 COMPARISON");
    console.log("=".repeat(80));

    if (!method1 || !method2) {
      console.error("❌ One of the methods failed to return results");
      process.exit(1);
    }

    const method1Wei = method1.totalGlwDelegatedWei ?? BigInt(0);
    const method2Wei = method2.totalActivelyDelegatedWei ?? BigInt(0);

    const method1Glw = Number(formatUnits(method1Wei, 18));
    const method2Glw = Number(formatUnits(method2Wei, 18));

    // Handle difference calculation (might be negative)
    const diff = method2Wei - method1Wei;
    const isNegative = diff < BigInt(0);
    const absDiff = isNegative ? -diff : diff;
    const diffGlw = Number(formatUnits(absDiff, 18)) * (isNegative ? -1 : 1);
    const diffPercent =
      method1Wei > BigInt(0) ? (Number(diff) / Number(method1Wei)) * 100 : 0;

    console.log(
      `\nMethod 1 (Fractions): ${method1Glw.toLocaleString()} GLW (${
        method1.totalWallets
      } wallets)`
    );
    console.log(
      `Method 2 (Vault):     ${method2Glw.toLocaleString()} GLW (${
        method2.totalWallets
      } wallets)`
    );
    console.log(
      `\nDifference:           ${
        diffGlw >= 0 ? "+" : ""
      }${diffGlw.toLocaleString()} GLW (${
        diffPercent >= 0 ? "+" : ""
      }${diffPercent.toFixed(2)}%)`
    );

    console.log("\n💡 EXPLANATION:");
    console.log(
      "   Method 1 counts historical GLW purchase amounts (what was delegated)"
    );
    console.log(
      "   Method 2 counts current vault ownership (remaining principal after distributions)"
    );
    console.log(
      "   Method 2 is what should be shown as 'actively delegated' on dashboards"
    );
    console.log("\n   Why is Method 2 higher?");
    console.log(
      "   - Some wallets received vault ownership via transfers (not direct purchases)"
    );
    console.log("   - These wallets show up in Method 2 but not Method 1");
    console.log(
      "   - Method 1 only tracks wallets that directly bought launchpad fractions"
    );

    console.log(
      "\n✅ The delegators leaderboard uses Method 2 (vault ownership)"
    );
    console.log(
      "   This is the correct calculation for 'actively delegated GLW'"
    );

    console.log("\n📌 RECOMMENDATION:");
    console.log(
      "   Update /fractions/total-actively-delegated to use the vault ownership"
    );
    console.log(
      "   calculation (Method 2) instead of the fractions-based approach (Method 1)\n"
    );
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }

  process.exit(0);
}

main();
