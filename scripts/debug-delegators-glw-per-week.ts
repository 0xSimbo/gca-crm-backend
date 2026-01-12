/**
 * Debug script: Diagnose why glwPerWeekWei shows as 0 in delegators leaderboard
 *
 * Usage:
 *   bun run scripts/debug-delegators-glw-per-week.ts
 *   bun run scripts/debug-delegators-glw-per-week.ts --limit 10
 */

import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";

interface Args {
  baseUrl: string;
  limit: number;
}

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function parseArgs(argv: string[]): Args {
  const baseUrl = getArgValue(argv, "--baseUrl") ?? "http://localhost:3005";
  const limit = parseOptionalInt(getArgValue(argv, "--limit")) ?? 10;

  if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid --limit");

  return { baseUrl, limit };
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("=== Delegators GLW Per Week Diagnostic ===\n");
  console.log("baseUrl:", args.baseUrl);
  console.log("limit:", args.limit);
  console.log("");

  // 1. Check what week range the API is using
  const weekRange = getWeekRangeForImpact();
  console.log("getWeekRangeForImpact():");
  console.log(`  startWeek: ${weekRange.startWeek}`);
  console.log(`  endWeek: ${weekRange.endWeek}`);
  console.log("");

  // 2. Fetch delegators leaderboard
  const url = new URL("/impact/delegators-leaderboard", args.baseUrl);
  url.searchParams.set("limit", String(args.limit));

  console.log("Fetching:", url.toString());
  console.log("");

  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    const text = await response.text();
    console.error("Request failed:", response.status);
    console.error(text);
    process.exit(1);
  }

  const data = (await response.json()) as any;

  console.log("Response weekRange:");
  console.log(`  startWeek: ${data.weekRange?.startWeek}`);
  console.log(`  endWeek: ${data.weekRange?.endWeek}`);
  console.log("");

  console.log(`Total wallets: ${data.totalWalletCount}`);
  console.log(`Returned wallets: ${data.wallets?.length || 0}`);
  console.log("");

  // 3. Analyze glwPerWeekWei values
  const wallets = data.wallets || [];
  const walletsWithZeroGlwPerWeek = wallets.filter(
    (w: any) => w.glwPerWeekWei === "0"
  );
  const walletsWithNonZeroGlwPerWeek = wallets.filter(
    (w: any) => w.glwPerWeekWei !== "0"
  );

  console.log("glwPerWeekWei Analysis:");
  console.log(
    `  Wallets with 0 glwPerWeekWei: ${walletsWithZeroGlwPerWeek.length}`
  );
  console.log(
    `  Wallets with non-zero glwPerWeekWei: ${walletsWithNonZeroGlwPerWeek.length}`
  );
  console.log("");

  if (walletsWithZeroGlwPerWeek.length === wallets.length) {
    console.log("⚠️  ALL WALLETS HAVE ZERO glwPerWeekWei!");
    console.log("");
    console.log("Likely cause:");
    console.log(
      `  The Control API does not have rewards data for week ${data.weekRange?.endWeek} yet.`
    );
    console.log(
      "  GCA reports are generated on Thursday for the previous week."
    );
    console.log(
      `  The most recent week with finalized rewards is likely ${
        (data.weekRange?.endWeek || 0) - 1
      } or earlier.`
    );
    console.log("");
  }

  // 4. Show sample wallets
  console.log("Sample wallets:");
  wallets
    .slice(0, Math.min(5, wallets.length))
    .forEach((w: any, idx: number) => {
      console.log(`  [${idx + 1}] ${w.walletAddress.slice(0, 10)}...`);
      console.log(
        `      activelyDelegatedGlwWei: ${w.activelyDelegatedGlwWei}`
      );
      console.log(`      glwPerWeekWei: ${w.glwPerWeekWei}`);
      console.log(`      netRewardsWei: ${w.netRewardsWei}`);
      console.log(`      sharePercent: ${w.sharePercent}%`);
    });
  console.log("");

  // 5. Compute the metric that the frontend displays
  let totalGlwPerWeekWei = BigInt(0);
  let totalActiveDelegatedWei = BigInt(0);

  for (const wallet of wallets) {
    totalGlwPerWeekWei += BigInt(wallet.glwPerWeekWei || "0");
    totalActiveDelegatedWei += BigInt(wallet.activelyDelegatedGlwWei || "0");
  }

  const glwPerWeekPer100Delegated =
    totalActiveDelegatedWei > 0
      ? (Number(totalGlwPerWeekWei) / Number(totalActiveDelegatedWei)) * 100
      : 0;

  console.log("Frontend Metric Calculation:");
  console.log(`  Total glwPerWeekWei: ${totalGlwPerWeekWei.toString()}`);
  console.log(
    `  Total activelyDelegatedGlwWei: ${totalActiveDelegatedWei.toString()}`
  );
  console.log(
    `  GLW per Week per 100 GLW Delegated: ${glwPerWeekPer100Delegated.toFixed(
      2
    )}`
  );
  console.log("");

  if (glwPerWeekPer100Delegated === 0) {
    console.log("❌ ISSUE CONFIRMED: GLW per Week per 100 GLW Delegated = 0");
  } else {
    console.log("✅ Metric is non-zero");
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("\n❌ Debug script failed:");
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
})();
