import { db } from "../src/db/db";
import { fractionSplits, fractions, applications } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getWalletFarmPurchases } from "../src/routers/fractions-router/helpers/accurate-apy-helpers";
import { getWeekRange } from "../src/routers/fractions-router/helpers/apy-helpers";

const WALLET_ADDRESS = "0x91701d7bf84c16833a39e2ec56bcb6b556e3f690";

async function debugWalletRewards() {
  console.log("=".repeat(80));
  console.log("🔍 DEBUGGING WALLET REWARDS");
  console.log("=".repeat(80));
  console.log(`Wallet: ${WALLET_ADDRESS}`);
  console.log("\n");

  const walletLower = WALLET_ADDRESS.toLowerCase();

  console.log("Step 1: Checking fraction splits in database...");
  console.log("-".repeat(80));
  
  const splits = await db
    .select({
      split: fractionSplits,
      fraction: fractions,
      application: applications,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .where(eq(fractionSplits.buyer, walletLower));

  console.log(`Found ${splits.length} fraction splits for this wallet`);
  
  if (splits.length === 0) {
    console.log("\n❌ NO SPLITS FOUND!");
    console.log("This wallet has never purchased any fraction splits.");
    console.log("\nPossible reasons:");
    console.log("1. Wrong wallet address");
    console.log("2. Wallet never made any purchases");
    console.log("3. Buyer address was stored differently in database");
    
    console.log("\n🔍 Searching for similar addresses...");
    const similarSplits = await db
      .select({
        buyer: fractionSplits.buyer,
      })
      .from(fractionSplits)
      .limit(10);
    
    console.log("\nSample buyer addresses in database:");
    similarSplits.forEach((s, i) => {
      console.log(`${i + 1}. ${s.buyer}`);
    });
    
    return;
  }

  console.log("\n📊 Split Details:");
  splits.forEach((s, i) => {
    console.log(`\nSplit #${i + 1}:`);
    console.log(`  Transaction: ${s.split.transactionHash}`);
    console.log(`  Fraction ID: ${s.fraction.id}`);
    console.log(`  Fraction Type: ${s.fraction.type}`);
    console.log(`  Application ID: ${s.application.id}`);
    console.log(`  Farm ID: ${s.application.farmId || "❌ NO FARM ID"}`);
    console.log(`  Steps Purchased: ${s.split.stepsPurchased}`);
    console.log(`  Amount: ${s.split.amount}`);
    console.log(`  Created At: ${s.split.createdAt}`);
  });

  const splitsWithoutFarmId = splits.filter(s => !s.application.farmId);
  if (splitsWithoutFarmId.length > 0) {
    console.log(`\n⚠️  WARNING: ${splitsWithoutFarmId.length} split(s) have no farmId!`);
    console.log("These will be excluded from rewards calculations.");
  }

  console.log("\n" + "=".repeat(80));
  console.log("Step 2: Getting farm purchases aggregation...");
  console.log("-".repeat(80));

  const farmPurchases = await getWalletFarmPurchases(walletLower);
  console.log(`Found ${farmPurchases.length} aggregated farm purchases`);

  if (farmPurchases.length === 0) {
    console.log("\n❌ NO FARM PURCHASES!");
    console.log("Even though splits exist, they don't map to valid farm purchases.");
    console.log("This is likely because applications don't have farmId set.");
    return;
  }

  console.log("\n📊 Farm Purchase Details:");
  farmPurchases.forEach((fp, i) => {
    console.log(`\nFarm #${i + 1}:`);
    console.log(`  Farm ID: ${fp.farmId}`);
    console.log(`  App ID: ${fp.appId}`);
    console.log(`  Type: ${fp.type}`);
    console.log(`  Amount Invested: ${fp.amountInvested.toString()}`);
    console.log(`  Steps Purchased: ${fp.stepsPurchased}`);
  });

  const totalDelegatorInvestment = farmPurchases
    .filter(f => f.type === "launchpad")
    .reduce((sum, f) => sum + f.amountInvested, BigInt(0));

  const totalMinerInvestment = farmPurchases
    .filter(f => f.type === "mining-center")
    .reduce((sum, f) => sum + f.amountInvested, BigInt(0));

  console.log("\n💰 Investment Summary:");
  console.log(`  Total GLW Delegated (launchpad): ${totalDelegatorInvestment.toString()}`);
  console.log(`  Total USDC Spent (mining-center): ${totalMinerInvestment.toString()}`);

  if (!process.env.CONTROL_API_URL) {
    console.log("\n❌ CONTROL_API_URL not configured!");
    console.log("Cannot fetch rewards data from Control API.");
    return;
  }

  console.log("\n" + "=".repeat(80));
  console.log("Step 3: Checking week range calculation...");
  console.log("-".repeat(80));
  
  const weekRange = getWeekRange();
  console.log(`getWeekRange() returns:`);
  console.log(`  Start Week: ${weekRange.startWeek}`);
  console.log(`  End Week: ${weekRange.endWeek}`);

  console.log("\n" + "=".repeat(80));
  console.log("Step 4: Fetching rewards from Control API...");
  console.log("-".repeat(80));
  console.log(`Control API URL: ${process.env.CONTROL_API_URL}`);

  const startWeek = 97;
  const endWeek = 150;

  try {
    const url = `${process.env.CONTROL_API_URL}/wallets/address/${walletLower}/farm-rewards-history?startWeek=${startWeek}&endWeek=${endWeek}`;
    console.log(`\nFetching: ${url}`);

    const response = await fetch(url);
    console.log(`Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.log("\n❌ Control API returned error response!");
      const errorText = await response.text();
      console.log(`Error: ${errorText}`);
      return;
    }

    const data = await response.json();
    const farmRewards = data.farmRewards || [];

    console.log(`\nReceived ${farmRewards.length} reward entries from Control API`);

    if (farmRewards.length === 0) {
      console.log("\n❌ NO REWARDS DATA FROM CONTROL API!");
      console.log("This wallet exists in CRM but has no rewards in Control API.");
      console.log("\nPossible reasons:");
      console.log("1. Control API doesn't have data for this wallet");
      console.log("2. The farmId in CRM doesn't match farms in Control API");
      console.log("3. The wallet never earned any rewards");
      
      console.log("\nFarm IDs from purchases:");
      const farmIds = [...new Set(farmPurchases.map(f => f.farmId))];
      farmIds.forEach(id => console.log(`  - ${id}`));
      
      return;
    }

    console.log("\n📊 Rewards by Farm:");
    const rewardsByFarm = new Map<string, any[]>();
    farmRewards.forEach((r: any) => {
      if (!rewardsByFarm.has(r.farmId)) {
        rewardsByFarm.set(r.farmId, []);
      }
      rewardsByFarm.get(r.farmId)!.push(r);
    });

    for (const [farmId, rewards] of rewardsByFarm) {
      console.log(`\n  Farm: ${farmId}`);
      console.log(`  Week entries: ${rewards.length}`);
      
      let totalLaunchpadInflation = BigInt(0);
      let totalLaunchpadDeposit = BigInt(0);
      let totalMinerInflation = BigInt(0);
      let totalMinerDeposit = BigInt(0);

      rewards.forEach(r => {
        totalLaunchpadInflation += BigInt(r.walletInflationFromLaunchpad || "0");
        totalLaunchpadDeposit += BigInt(r.walletProtocolDepositFromLaunchpad || "0");
        totalMinerInflation += BigInt(r.walletInflationFromMiningCenter || "0");
        totalMinerDeposit += BigInt(r.walletProtocolDepositFromMiningCenter || "0");
      });

      console.log(`  Week breakdown:`);
      rewards.forEach(r => {
        const launchpadTotal = BigInt(r.walletInflationFromLaunchpad || "0") + BigInt(r.walletProtocolDepositFromLaunchpad || "0");
        const minerTotal = BigInt(r.walletInflationFromMiningCenter || "0") + BigInt(r.walletProtocolDepositFromMiningCenter || "0");
        if (launchpadTotal > 0 || minerTotal > 0) {
          console.log(`    Week ${r.weekNumber}: Launchpad=${launchpadTotal.toString()}, Miner=${minerTotal.toString()}`);
        }
      });

      console.log(`  Launchpad Inflation: ${totalLaunchpadInflation.toString()}`);
      console.log(`  Launchpad Deposit: ${totalLaunchpadDeposit.toString()}`);
      console.log(`  Miner Inflation: ${totalMinerInflation.toString()}`);
      console.log(`  Miner Deposit: ${totalMinerDeposit.toString()}`);
      console.log(`  Total Launchpad: ${(totalLaunchpadInflation + totalLaunchpadDeposit).toString()}`);
      console.log(`  Total Miner: ${(totalMinerInflation + totalMinerDeposit).toString()}`);
    }

    console.log("\n" + "=".repeat(80));
    console.log("Step 5: Matching farms with rewards...");
    console.log("-".repeat(80));

    const purchaseFarmIds = new Set(farmPurchases.map(f => f.farmId));
    const rewardFarmIds = new Set(farmRewards.map((r: any) => r.farmId));

    console.log("\nFarm IDs in purchases:", Array.from(purchaseFarmIds));
    console.log("Farm IDs in rewards:", Array.from(rewardFarmIds));

    const matchingFarms = [...purchaseFarmIds].filter(id => rewardFarmIds.has(id));
    const purchasesOnly = [...purchaseFarmIds].filter(id => !rewardFarmIds.has(id));
    const rewardsOnly = [...rewardFarmIds].filter(id => !purchaseFarmIds.has(id));

    console.log("\n✅ Matching farms:", matchingFarms.length > 0 ? matchingFarms : "NONE");
    if (purchasesOnly.length > 0) {
      console.log("⚠️  Farms with purchases but no rewards:", purchasesOnly);
    }
    if (rewardsOnly.length > 0) {
      console.log("⚠️  Farms with rewards but no purchases:", rewardsOnly);
    }

    if (matchingFarms.length === 0) {
      console.log("\n❌ FARM ID MISMATCH!");
      console.log("The farmIds in the CRM database don't match the farmIds in Control API.");
      console.log("This is why the endpoint returns 0 rewards.");
    }

  } catch (error) {
    console.log("\n❌ Error fetching from Control API:");
    console.log(error);
  }

  console.log("\n" + "=".repeat(80));
  console.log("✅ Debug complete!");
  console.log("=".repeat(80));
}

debugWalletRewards()
  .then(() => {
    console.log("\n✅ Script finished successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:");
    console.error(error);
    process.exit(1);
  });

