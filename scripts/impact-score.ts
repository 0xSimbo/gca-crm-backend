import { formatUnits } from "viem";

import { getWeekRange } from "../src/routers/fractions-router/helpers/apy-helpers";
import { computeGlowImpactScores } from "../src/routers/impact-router/helpers/impact-score";

function parseOptionalArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function parseOptionalInt(name: string): number | undefined {
  const value = parseOptionalArg(name);
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatGlwWei(value: string): string {
  try {
    return formatUnits(BigInt(value), 18);
  } catch {
    return "0";
  }
}

/**
 * Usage:
 *  bun run scripts/impact-score.ts <walletAddress> [--startWeek=97] [--endWeek=107]
 *
 * Prints:
 *  - Totals summary
 *  - Full JSON response (same shape as GET /impact/glow-score?walletAddress=...)
 */
async function main() {
  const walletAddressRaw = process.argv[2];
  if (!walletAddressRaw || !/^0x[a-fA-F0-9]{40}$/.test(walletAddressRaw)) {
    console.error("❌ Missing or invalid wallet address.");
    console.error(
      "Usage: bun run scripts/impact-score.ts <walletAddress> [--startWeek=97] [--endWeek=107]"
    );
    process.exit(1);
  }

  const walletAddress = walletAddressRaw.toLowerCase();
  const range = getWeekRange();
  const startWeek = parseOptionalInt("startWeek") ?? range.startWeek;
  const endWeek = parseOptionalInt("endWeek") ?? range.endWeek;

  if (endWeek < startWeek) {
    console.error("❌ endWeek must be >= startWeek");
    process.exit(1);
  }

  const [result] = await computeGlowImpactScores({
    walletAddresses: [walletAddress],
    startWeek,
    endWeek,
    includeWeeklyBreakdown: true,
  });

  if (!result) {
    console.error("❌ No result returned for wallet.");
    process.exit(1);
  }

  console.log("=== Glow Impact Score ===");
  console.log(`Wallet: ${result.walletAddress}`);
  console.log(
    `Week range: ${result.weekRange.startWeek} - ${result.weekRange.endWeek}`
  );
  console.log("");

  console.log("--- Totals ---");
  console.log(`Total points: ${result.totals.totalPoints}`);
  console.log(`- Rollover points: ${result.totals.rolloverPoints}`);
  console.log(`  - Inflation points: ${result.totals.inflationPoints}`);
  console.log(`  - Steering points: ${result.totals.steeringPoints}`);
  console.log(`  - Vault bonus points: ${result.totals.vaultBonusPoints}`);
  console.log(`- Continuous points: ${result.totals.continuousPoints}`);
  console.log("");

  console.log("--- Glow Worth (current) ---");
  console.log(
    `Liquid GLW: ${formatGlwWei(result.glowWorth.liquidGlwWei)} (${
      result.glowWorth.liquidGlwWei
    } wei)`
  );
  console.log(
    `DelegatedActive GLW: ${formatGlwWei(
      result.glowWorth.delegatedActiveGlwWei
    )} (${result.glowWorth.delegatedActiveGlwWei} wei)`
  );
  console.log(
    `Unclaimed GLW rewards: ${formatGlwWei(
      result.glowWorth.unclaimedGlwRewardsWei
    )} (${result.glowWorth.unclaimedGlwRewardsWei} wei)`
  );
  console.log(
    `GlowWorth: ${formatGlwWei(result.glowWorth.glowWorthWei)} (${
      result.glowWorth.glowWorthWei
    } wei)`
  );
  console.log("");

  console.log("--- Full JSON ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("❌ Failed to compute impact score:", error);
  process.exit(1);
});
