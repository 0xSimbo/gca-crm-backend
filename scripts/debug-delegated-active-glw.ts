/**
 * Debug script: explain how `delegatedActiveGlwWei` is computed for a wallet.
 *
 * Vault-ownership model (GLW-only protocol deposit vault):
 * - Farm principalPaidGlwWei = sum(applications.paymentAmount) where paymentCurrency=GLW and status=completed
 * - Farm recoveredDistributedGlwWei = sum(Control weekly protocolDepositRewardsDistributed, GLW only)
 * - Farm remainingPrincipalGlwWei = max(0, principalPaidGlwWei - recoveredDistributedGlwWei)
 * - Wallet deposit split ownership is depositSplitPercent6Decimals(wallet,farm,week=endWeek)
 * - Wallet delegatedActive contribution = remainingPrincipalGlwWei * split / 1e6
 *
 * Notes:
 * - Miners only earn inflation; depositSplitPercent6Decimals is always 0 for mining center.
 * - `walletProtocolDepositFromLaunchpad` (wallet received) is printed as a diagnostic only; it is
 *   NOT used for delegatedActive under the vault model.
 *
 * Usage:
 *   bun run scripts/debug-delegated-active-glw.ts --wallet 0x... --endWeek 111
 *   bun run scripts/debug-delegated-active-glw.ts --wallet 0x... --startWeek 97 --endWeek 111 --farmsOnly
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db/db";
import { applications, farms } from "../src/db/schema";
import {
  fetchDepositSplitsHistoryBatch,
  fetchFarmRewardsHistoryBatch,
  fetchWalletRewardsHistoryBatch,
} from "../src/routers/impact-router/helpers/control-api";

interface Args {
  wallet: string;
  startWeek: number;
  endWeek: number;
  farmsOnly: boolean;
  top: number;
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
  const topRaw = getArgValue(argv, "--top") ?? "20";
  const startWeek = Number(startWeekRaw);
  const endWeek = Number(endWeekRaw);
  const top = Number(topRaw);

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet))
    throw new Error(`Invalid wallet address: ${wallet}`);
  if (
    !Number.isFinite(startWeek) ||
    !Number.isFinite(endWeek) ||
    endWeek < startWeek
  )
    throw new Error(
      `Invalid week range: startWeek=${startWeekRaw} endWeek=${endWeekRaw}`
    );

  return {
    wallet: wallet.toLowerCase(),
    // Delegations started in week 97; always seed from week 97 to match backend semantics.
    startWeek: 97,
    endWeek: Math.trunc(endWeek),
    top: Number.isFinite(top) ? Math.max(1, Math.trunc(top)) : 20,
    farmsOnly:
      argv.includes("--farmsOnly") ||
      argv.includes("--farms-only") ||
      argv.includes("--onlyFarms") ||
      argv.includes("--only-farms"),
  };
}

function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return 0n;
  } catch {
    return 0n;
  }
}

function clampToZero(x: bigint): bigint {
  return x > 0n ? x : 0n;
}

function formatUnits18(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const s = abs.toString().padStart(19, "0");
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

function isGlwAsset(asset: string | null | undefined): boolean {
  return (asset || "").toUpperCase() === "GLW";
}

function logStep(message: string, extra?: unknown) {
  const ts = new Date().toISOString();
  if (extra === undefined) {
    console.log(`[${ts}] ${message}`);
    return;
  }
  console.log(`[${ts}] ${message}`, extra);
}

async function withTimeout<T>(
  label: string,
  ms: number,
  promise: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ])) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getSplitScaled6AtWeek(
  segments: Array<{
    startWeek: number;
    endWeek: number;
    depositSplitPercent6Decimals: string;
  }>,
  week: number
): bigint {
  for (const s of segments) {
    if (week < s.startWeek || week > s.endWeek) continue;
    return safeBigInt(s.depositSplitPercent6Decimals);
  }
  return 0n;
}

async function main() {
  const { wallet, startWeek, endWeek, farmsOnly, top } = parseArgs(
    process.argv
  );

  console.log("wallet:", wallet);
  console.log("range:", { startWeek, endWeek });
  if (farmsOnly) console.log("mode: farmsOnly");
  console.log("top:", top);
  console.log("");

  // Environment visibility (mask secrets)
  const pg = process.env.PG_DATABASE_URL;
  const control = process.env.CONTROL_API_URL;
  const rpc = process.env.MAINNET_RPC_URL;
  try {
    if (pg) {
      const u = new URL(pg);
      logStep("env PG_DATABASE_URL:", {
        protocol: u.protocol,
        host: u.host,
        pathname: u.pathname,
      });
    } else {
      logStep("env PG_DATABASE_URL: <missing>");
    }
  } catch {
    logStep("env PG_DATABASE_URL: <present but not a URL>");
  }
  logStep("env CONTROL_API_URL:", control ? "<present>" : "<missing>");
  logStep("env MAINNET_RPC_URL:", rpc ? "<present>" : "<missing>");
  console.log("");

  logStep("db: connectivity check (SELECT 1)...");
  await withTimeout(
    "db connectivity check",
    10_000,
    db.execute(sql`select 1 as ok`)
  );
  logStep("db: connectivity check OK");
  console.log("");

  logStep("control api: fetching deposit split history (vault ownership)...");
  const splitMap = await withTimeout(
    "control api deposit split history",
    60_000,
    fetchDepositSplitsHistoryBatch({
      wallets: [wallet],
      startWeek,
      endWeek,
    })
  );
  const splitSegments = splitMap.get(wallet) || [];
  logStep("control api: deposit split segments:", splitSegments.length);

  const segmentsByFarmId = new Map<string, typeof splitSegments>();
  for (const seg of splitSegments) {
    const list = segmentsByFarmId.get(seg.farmId) || [];
    list.push(seg);
    segmentsByFarmId.set(seg.farmId, list);
  }

  const farmIdsWithNonZeroSplitAtEndWeek: string[] = [];
  for (const [farmId, segs] of segmentsByFarmId) {
    const splitAtEndWeek = getSplitScaled6AtWeek(segs, endWeek);
    if (splitAtEndWeek > 0n) farmIdsWithNonZeroSplitAtEndWeek.push(farmId);
  }

  logStep("farms with non-zero deposit split at endWeek:", {
    count: farmIdsWithNonZeroSplitAtEndWeek.length,
    endWeek,
  });

  if (farmIdsWithNonZeroSplitAtEndWeek.length === 0) {
    console.log("");
    console.log("No deposit split history found for this wallet.");
    return;
  }

  logStep("db: fetching GLW-paid principal (applications) for these farms...");
  const principalRows = await db
    .select({
      farmId: applications.farmId,
      paymentAmount: applications.paymentAmount,
      farmName: farms.name,
    })
    .from(applications)
    .leftJoin(farms, eq(applications.farmId, farms.id))
    .where(
      and(
        inArray(applications.farmId, farmIdsWithNonZeroSplitAtEndWeek),
        eq(applications.isCancelled, false),
        eq(applications.status, "completed"),
        eq(applications.paymentCurrency, "GLW")
      )
    );

  const principalByFarmId = new Map<string, bigint>();
  const farmNameById = new Map<string, string>();
  for (const row of principalRows) {
    const farmId = String(row.farmId || "").trim();
    if (!farmId) continue;
    const principalWei = safeBigInt(row.paymentAmount);
    if (principalWei <= 0n) continue;
    principalByFarmId.set(
      farmId,
      (principalByFarmId.get(farmId) || 0n) + principalWei
    );
    if (row.farmName) farmNameById.set(farmId, row.farmName);
  }
  logStep("db: GLW principal farms:", principalByFarmId.size);

  const glwFarmIds = Array.from(principalByFarmId.keys());
  if (glwFarmIds.length === 0) {
    console.log("");
    console.log(
      "No GLW-paid applications found for farms referenced by this wallet's deposit split history."
    );
    return;
  }

  logStep("control api: fetching farm rewards history (PD distributed)...");
  const distributedByFarmId = new Map<string, bigint>();
  const BATCH = 100;
  for (let i = 0; i < glwFarmIds.length; i += BATCH) {
    const batch = glwFarmIds.slice(i, i + BATCH);
    const m = await withTimeout(
      "control api farm rewards history batch",
      60_000,
      fetchFarmRewardsHistoryBatch({
        farmIds: batch,
        startWeek,
        endWeek,
      })
    );
    for (const farmId of batch) {
      const rows = m.get(farmId) || [];
      let cumulative = 0n;
      for (const r of rows) {
        if (String(r.paymentCurrency || "").toUpperCase() !== "GLW") continue;
        cumulative += safeBigInt(r.protocolDepositRewardsDistributed);
      }
      distributedByFarmId.set(farmId, cumulative);
    }
  }

  // Extra diagnostics (optional): how much PD reward did this wallet actually receive?
  // Not used in delegatedActive under the vault model, and we skip it for farmsOnly for speed.
  const recoveredToWalletByFarmId = new Map<string, bigint>();
  if (!farmsOnly) {
    logStep(
      "control api: fetching wallet farm rewards (wallet PD received)..."
    );
    const walletRewardsMap = await withTimeout(
      "control api wallet farm rewards history batch",
      60_000,
      fetchWalletRewardsHistoryBatch({
        wallets: [wallet],
        startWeek,
        endWeek,
      })
    );
    const rewardRows = walletRewardsMap.get(wallet) || [];
    for (const r of rewardRows) {
      if (!isGlwAsset(r.asset)) continue;
      const amountRaw = safeBigInt(r.walletProtocolDepositFromLaunchpad);
      if (amountRaw <= 0n) continue;
      recoveredToWalletByFarmId.set(
        r.farmId,
        (recoveredToWalletByFarmId.get(r.farmId) || 0n) + amountRaw
      );
    }
  }

  console.log("");
  console.log(
    "per-farm vault breakdown (GLW principal, distributed, split, shares):"
  );

  let totalPrincipalWei = 0n;
  let totalDistributedWei = 0n;
  let totalGrossShareWei = 0n;
  let totalActiveShareWei = 0n;
  let totalRecoveredToWalletWei = 0n;

  const rows = glwFarmIds
    .map((farmId) => {
      const principalWei = principalByFarmId.get(farmId) || 0n;
      const distributedWei = distributedByFarmId.get(farmId) || 0n;
      const remainingWei = clampToZero(principalWei - distributedWei);
      const segs = segmentsByFarmId.get(farmId) || [];
      const splitScaled6 = getSplitScaled6AtWeek(segs, endWeek);
      const grossShareWei = (principalWei * splitScaled6) / 1_000_000n;
      const activeShareWei = (remainingWei * splitScaled6) / 1_000_000n;
      const recoveredToWalletWei = recoveredToWalletByFarmId.get(farmId) || 0n;
      return {
        farmId,
        farmName: farmNameById.get(farmId) || farmId,
        principalWei,
        distributedWei,
        remainingWei,
        splitScaled6,
        grossShareWei,
        activeShareWei,
        recoveredToWalletWei,
      };
    })
    .sort((a, b) =>
      a.activeShareWei > b.activeShareWei
        ? -1
        : a.activeShareWei < b.activeShareWei
        ? 1
        : a.farmName.localeCompare(b.farmName)
    );

  const topRows = rows.slice(0, top);
  console.log("");
  console.log(`top farms by walletActiveShareRemaining (endWeek=${endWeek}):`);

  for (const r of topRows) {
    totalPrincipalWei += r.principalWei;
    totalDistributedWei += r.distributedWei;
    totalGrossShareWei += r.grossShareWei;
    totalActiveShareWei += r.activeShareWei;
    totalRecoveredToWalletWei += r.recoveredToWalletWei;

    console.log(`- ${r.farmName} (${r.farmId})`);
    console.log(
      `  farmPrincipalPaid(GLW)=${formatUnits18(r.principalWei)} GLW`
    );
    console.log(
      `  farmDistributedToDate(GLW)=${formatUnits18(r.distributedWei)} GLW`
    );
    console.log(`  farmRemaining(GLW)=${formatUnits18(r.remainingWei)} GLW`);
    console.log(
      `  walletDepositSplitPercent6Decimals=${r.splitScaled6.toString()}`
    );
    console.log(
      `  walletGrossShareOfPrincipal=${formatUnits18(r.grossShareWei)} GLW`
    );
    console.log(
      `  walletActiveShareRemaining=${formatUnits18(r.activeShareWei)} GLW`
    );
    if (!farmsOnly) {
      console.log(
        `  walletRecoveredToDate(protocolDepositRewardsReceived, GLW)=${formatUnits18(
          r.recoveredToWalletWei
        )} GLW`
      );
    }
  }

  console.log("");
  console.log("totals:");
  console.log(
    `farmPrincipalPaidGlw (top ${topRows.length}):`,
    formatUnits18(totalPrincipalWei)
  );
  console.log(
    `farmDistributedGlw (top ${topRows.length}):`,
    formatUnits18(totalDistributedWei)
  );
  console.log(
    `walletGrossShareOfPrincipal (top ${topRows.length}):`,
    formatUnits18(totalGrossShareWei)
  );
  console.log(
    "walletActiveShareRemaining(endWeek):",
    formatUnits18(totalActiveShareWei)
  );
  console.log(
    "walletActiveShareRemainingWei(endWeek):",
    totalActiveShareWei.toString()
  );
  if (!farmsOnly) {
    console.log(
      "walletRecoveredToDate(protocolDepositRewardsReceived, GLW):",
      formatUnits18(totalRecoveredToWalletWei)
    );
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("debug-delegated-active-glw FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();
