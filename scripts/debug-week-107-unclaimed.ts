/**
 * Debug script to trace why Week 107 has 18,761 GLW unclaimed instead of ~9,691 GLW
 *
 * Usage:
 *   CONTROL_API_URL=https://api-prod-34ce.up.railway.app bun scripts/debug-week-107-unclaimed.ts
 */

const WALLET = "0x77f41144e787cb8cd29a37413a71f53f92ee050c";
const TARGET_WEEK = 107;

const GENESIS_TIMESTAMP = 1700352000;
const WEEK_SECONDS = 604800;
const WEEK_97_START_TIMESTAMP = GENESIS_TIMESTAMP + 97 * WEEK_SECONDS;
const GLW_TOKEN = "0xf4fbc617a5733eaaf9af08e1ab816b103388d8b6";
const AMOUNT_MATCH_EPSILON_WEI = BigInt(10_000_000); // 10M wei

const CONTROL_API_URL = process.env.CONTROL_API_URL || "https://api-prod-34ce.up.railway.app";
const CLAIMS_API_URL = "https://glow-ponder-listener-2-production.up.railway.app";

function weekEndTimestamp(week: number): number {
  return GENESIS_TIMESTAMP + (week + 1) * WEEK_SECONDS;
}

function timestampToDate(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

async function main() {
  console.log(`\n=== Debugging Week ${TARGET_WEEK} Unclaimed for ${WALLET} ===\n`);

  const week107End = weekEndTimestamp(TARGET_WEEK);
  console.log(`Week ${TARGET_WEEK} ends at: ${timestampToDate(week107End)} (ts: ${week107End})`);
  console.log(`Inflation claimable up to week: ${TARGET_WEEK - 3} (${TARGET_WEEK - 3})`);
  console.log(`PD claimable up to week: ${TARGET_WEEK - 4} (${TARGET_WEEK - 4})\n`);

  // Fetch weekly rewards from Control API
  console.log("1. Fetching weekly rewards from Control API...");
  const weeklyResp = await fetch(
    `${CONTROL_API_URL}/wallets/address/${WALLET}/weekly-rewards?paymentCurrency=GLW&limit=52`
  );
  const weeklyData = await weeklyResp.json() as any;
  const rewards = (weeklyData?.rewards || []) as any[];

  const inflationByWeek = new Map<number, bigint>();
  const pdByWeek = new Map<number, bigint>();

  for (const r of rewards) {
    const week = Number(r?.weekNumber ?? -1);
    if (!Number.isFinite(week) || week < 97) continue;

    const inflationWei = BigInt(r?.glowInflationTotal || "0");
    const pdWei = BigInt(r?.protocolDepositRewardTotal || "0");

    if (inflationWei > 0n) inflationByWeek.set(week, inflationWei);
    if (pdWei > 0n) pdByWeek.set(week, pdWei);
  }

  console.log("\nInflation by week:");
  for (const [w, v] of Array.from(inflationByWeek).sort((a, b) => a[0] - b[0])) {
    const claimable = w <= TARGET_WEEK - 3 ? "✅ claimable" : "❌ not claimable yet";
    console.log(`  Week ${w}: ${Number(v) / 1e18} GLW (${claimable})`);
  }

  console.log("\nPD by week:");
  for (const [w, v] of Array.from(pdByWeek).sort((a, b) => a[0] - b[0])) {
    const claimable = w <= TARGET_WEEK - 4 ? "✅ claimable" : "❌ not claimable yet";
    console.log(`  Week ${w}: ${Number(v) / 1e18} GLW (${claimable})`);
  }

  // Fetch claims from Ponder
  console.log("\n2. Fetching claims from Ponder...");
  const claimsResp = await fetch(`${CLAIMS_API_URL}/rewards/claims/${WALLET}?limit=5000`);
  const claimsData = await claimsResp.json() as any;
  const claims = (claimsData?.claims || []) as any[];

  // PD claims (from nonce)
  console.log("\nPD Claims (from RewardsKernel nonce):");
  const pdClaimsMap = new Map<number, number>();
  for (const c of claims) {
    const source = String(c?.source || "");
    if (source !== "rewardsKernel") continue;

    const nonce = Number(c?.nonce);
    if (!Number.isFinite(nonce) || nonce < 0) continue;

    const week = nonce + 16;
    if (week < 97) continue;

    const timestamp = Number(c?.timestamp);
    pdClaimsMap.set(week, timestamp);

    const beforeWeek107End = timestamp < week107End;
    console.log(`  Week ${week}: claimed at ${timestampToDate(timestamp)} (${beforeWeek107End ? "BEFORE" : "AFTER"} Week ${TARGET_WEEK} ended)`);
  }

  // Inflation claims (inferred from minerPool transfers)
  console.log("\nInflation Claims (inferred from MinerPool amounts):");
  const inflationClaimsMap = new Map<number, number>();
  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    if (token !== GLW_TOKEN) continue;

    const timestamp = Number(c?.timestamp);
    if (timestamp < WEEK_97_START_TIMESTAMP) continue;

    const source = String(c?.source || "");
    if (source !== "minerPool") continue;

    const amountWei = BigInt(c?.amount || "0");

    let bestWeek: number | null = null;
    let bestDiff: bigint | null = null;
    let secondBestDiff: bigint | null = null;

    for (const [week, v] of inflationByWeek) {
      if (week < 97) continue;
      const diff = amountWei >= v ? amountWei - v : v - amountWei;
      if (bestDiff == null || diff < bestDiff) {
        secondBestDiff = bestDiff;
        bestDiff = diff;
        bestWeek = week;
        continue;
      }
      if (secondBestDiff == null || diff < secondBestDiff) secondBestDiff = diff;
    }

    if (bestWeek != null && bestDiff != null && bestDiff <= AMOUNT_MATCH_EPSILON_WEI) {
      if (secondBestDiff == null || secondBestDiff > AMOUNT_MATCH_EPSILON_WEI) {
        inflationClaimsMap.set(bestWeek, timestamp);
        const beforeWeek107End = timestamp < week107End;
        console.log(`  Week ${bestWeek}: claimed at ${timestampToDate(timestamp)} (${beforeWeek107End ? "BEFORE" : "AFTER"} Week ${TARGET_WEEK} ended) - amount: ${Number(amountWei) / 1e18} GLW`);
      } else {
        console.log(`  AMBIGUOUS: amount ${Number(amountWei) / 1e18} GLW matches multiple weeks (skipped)`);
      }
    }
  }

  // Calculate historical unclaimed for Week 107
  console.log(`\n3. Calculating Historical Unclaimed for Week ${TARGET_WEEK}...`);
  console.log(`   Week ${TARGET_WEEK} ends at: ${timestampToDate(week107End)} (ts: ${week107End})`);

  let historicalUnclaimedWei = 0n;
  const inflationClaimableUpToWeek = TARGET_WEEK - 3;
  const pdClaimableUpToWeek = TARGET_WEEK - 4;

  console.log(`\n   Inflation (claimable up to week ${inflationClaimableUpToWeek}):`);
  for (const [rw, amount] of inflationByWeek) {
    if (rw <= inflationClaimableUpToWeek) {
      const claimTimestamp = inflationClaimsMap.get(rw);
      const wasUnclaimed = !claimTimestamp || claimTimestamp > week107End;

      if (wasUnclaimed) {
        historicalUnclaimedWei += amount;
        console.log(`   ✅ Week ${rw}: ${Number(amount) / 1e18} GLW - UNCLAIMED (${claimTimestamp ? `claimed ${timestampToDate(claimTimestamp)} AFTER week end` : "never claimed"})`);
      } else {
        console.log(`   ❌ Week ${rw}: ${Number(amount) / 1e18} GLW - CLAIMED (at ${timestampToDate(claimTimestamp!)} BEFORE week end)`);
      }
    } else {
      console.log(`   ⏳ Week ${rw}: ${Number(amount) / 1e18} GLW - NOT YET CLAIMABLE`);
    }
  }

  console.log(`\n   PD (claimable up to week ${pdClaimableUpToWeek}):`);
  for (const [rw, amount] of pdByWeek) {
    if (rw <= pdClaimableUpToWeek) {
      const claimTimestamp = pdClaimsMap.get(rw);
      const wasUnclaimed = !claimTimestamp || claimTimestamp > week107End;

      if (wasUnclaimed) {
        historicalUnclaimedWei += amount;
        console.log(`   ✅ Week ${rw}: ${Number(amount) / 1e18} GLW - UNCLAIMED (${claimTimestamp ? `claimed ${timestampToDate(claimTimestamp)} AFTER week end` : "never claimed"})`);
      } else {
        console.log(`   ❌ Week ${rw}: ${Number(amount) / 1e18} GLW - CLAIMED (at ${timestampToDate(claimTimestamp!)} BEFORE week end)`);
      }
    } else {
      console.log(`   ⏳ Week ${rw}: ${Number(amount) / 1e18} GLW - NOT YET CLAIMABLE`);
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`Historical Unclaimed for Week ${TARGET_WEEK}: ${Number(historicalUnclaimedWei) / 1e18} GLW`);
  console.log(`Expected: ~9,691 GLW (Week 104 inflation only)`);
  console.log(`Actual from API: 18,761 GLW`);
  console.log(`Gap: ${18761 - Number(historicalUnclaimedWei) / 1e18} GLW`);
}

main().catch(console.error);

