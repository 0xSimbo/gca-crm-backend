import { describe, it, expect } from "bun:test";

const BASE_URL = "http://localhost:3005";

describe("/fractions/rewards-breakdown", () => {
  describe("Wallet with 1 delegation", () => {
    const walletAddress = "0x5e230fed487c86b90f6508104149f087d9b1b0a7";

    it("should return wallet rewards breakdown", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty("type", "wallet");
      expect(data).toHaveProperty("walletAddress", walletAddress.toLowerCase());
      expect(data).toHaveProperty("farms");
      expect(data).toHaveProperty("farmStatistics");
      expect(data).toHaveProperty("totals");
      expect(data).toHaveProperty("weekRange");
      expect(data).toHaveProperty("rewards");
      expect(data).toHaveProperty("apy");
      expect(data).toHaveProperty("farmDetails");
      expect(data).toHaveProperty("otherFarmsWithRewards");

      expect(Array.isArray(data.farms)).toBe(true);
      expect(data.farms.length).toBeGreaterThan(0);

      expect(data.farmStatistics).toHaveProperty("totalFarms");
      expect(data.farmStatistics).toHaveProperty("delegatorOnlyFarms");
      expect(data.farmStatistics).toHaveProperty("minerOnlyFarms");
      expect(data.farmStatistics).toHaveProperty("bothTypesFarms");

      expect(data.farmStatistics.delegatorOnlyFarms).toBeGreaterThanOrEqual(1);

      expect(data.totals).toHaveProperty("totalGlwDelegated");
      expect(data.totals).toHaveProperty("totalUsdcSpentByMiners");

      const totalGlwDelegated = BigInt(data.totals.totalGlwDelegated);
      expect(totalGlwDelegated).toBeGreaterThan(BigInt(0));

      expect(data.rewards).toHaveProperty("delegator");
      expect(data.rewards).toHaveProperty("miner");

      expect(data.apy).toHaveProperty("delegatorApyPercent");
      expect(data.apy).toHaveProperty("minerApyPercent");

      expect(Array.isArray(data.farmDetails)).toBe(true);
      expect(data.farmDetails.length).toBeGreaterThan(0);

      const launchpadFarms = data.farmDetails.filter(
        (f: any) => f.type === "launchpad"
      );
      expect(launchpadFarms.length).toBeGreaterThanOrEqual(1);

      for (const farm of data.farmDetails) {
        expect(farm).toHaveProperty("farmId");
        expect(farm).toHaveProperty("type");
        expect(farm).toHaveProperty("amountInvested");
        expect(farm).toHaveProperty("totalEarnedSoFar");
        expect(farm).toHaveProperty("apy");
        expect(farm).toHaveProperty("weeklyBreakdown");
        expect(Array.isArray(farm.weeklyBreakdown)).toBe(true);
      }

      console.log(`✓ Wallet ${walletAddress} has ${data.farms.length} farms`);
      console.log(
        `✓ Farm statistics: ${data.farmStatistics.delegatorOnlyFarms} delegator-only, ${data.farmStatistics.minerOnlyFarms} miner-only, ${data.farmStatistics.bothTypesFarms} both`
      );
      console.log(`✓ Total GLW delegated: ${data.totals.totalGlwDelegated}`);
      console.log(
        `✓ Other farms with rewards: ${data.otherFarmsWithRewards.count}`
      );
    });

    it("should include week range information", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      const data = await response.json();

      expect(data.weekRange).toHaveProperty("startWeek");
      expect(data.weekRange).toHaveProperty("endWeek");
      expect(data.weekRange).toHaveProperty("weeksWithRewards");

      expect(data.weekRange.startWeek).toBe(97);
      expect(data.weekRange.endWeek).toBeGreaterThanOrEqual(97);
      expect(data.weekRange.weeksWithRewards).toBeGreaterThan(0);

      console.log(
        `✓ Week range: ${data.weekRange.startWeek} - ${data.weekRange.endWeek} (${data.weekRange.weeksWithRewards} weeks with rewards)`
      );
    });

    it("should allow custom week range", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}&startWeek=100&endWeek=105`
      );

      expect(response.ok).toBe(true);

      const data = await response.json();

      expect(data.weekRange.startWeek).toBe(100);
      expect(data.weekRange.endWeek).toBe(105);

      console.log(`✓ Custom week range applied: 100-105`);
    });
  });

  describe("Wallet with 1 other farm", () => {
    const walletAddress = "0x2e565baa402c232799690d311f4b43d17212a709";

    it("should return wallet rewards breakdown with other farms", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty("type", "wallet");
      expect(data).toHaveProperty("walletAddress", walletAddress.toLowerCase());
      expect(data).toHaveProperty("otherFarmsWithRewards");

      expect(data.otherFarmsWithRewards).toHaveProperty("count");
      expect(data.otherFarmsWithRewards).toHaveProperty("farms");

      expect(data.otherFarmsWithRewards.count).toBeGreaterThanOrEqual(1);

      if (data.otherFarmsWithRewards.count > 0) {
        const otherFarms = data.otherFarmsWithRewards.farms;
        expect(Array.isArray(otherFarms)).toBe(true);
        expect(otherFarms.length).toBeGreaterThanOrEqual(1);

        for (const farm of otherFarms) {
          expect(farm).toHaveProperty("farmId");
          expect(farm).toHaveProperty("farmName");
          expect(farm).toHaveProperty("totalRewards");
          expect(farm).toHaveProperty("lastWeekRewards");
          expect(farm).toHaveProperty("weeklyBreakdown");
          expect(farm).toHaveProperty("builtEpoch");
          expect(farm).toHaveProperty("weeksLeft");
          expect(farm).toHaveProperty("asset");

          const totalRewards = BigInt(farm.totalRewards);
          expect(totalRewards).toBeGreaterThan(BigInt(0));

          expect(Array.isArray(farm.weeklyBreakdown)).toBe(true);
          expect(farm.weeklyBreakdown.length).toBeGreaterThan(0);
        }

        console.log(
          `✓ Wallet ${walletAddress} has ${data.otherFarmsWithRewards.count} other farm(s) with rewards`
        );
        console.log(`✓ Other farms details:`);
        for (const farm of otherFarms) {
          console.log(
            `  - Farm ${farm.farmId} (${farm.farmName || "Unknown"}): ${
              farm.totalRewards
            } total rewards`
          );
        }
      }
    });

    it("should validate other farms structure", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      const data = await response.json();

      if (data.otherFarmsWithRewards.count > 0) {
        const firstFarm = data.otherFarmsWithRewards.farms[0];

        expect(firstFarm).toHaveProperty("totalInflationRewards");
        expect(firstFarm).toHaveProperty("totalProtocolDepositRewards");

        const totalInflation = BigInt(firstFarm.totalInflationRewards);
        const totalDeposit = BigInt(firstFarm.totalProtocolDepositRewards);
        const totalRewards = BigInt(firstFarm.totalRewards);

        expect(totalRewards).toBe(totalInflation + totalDeposit);

        for (const weekData of firstFarm.weeklyBreakdown) {
          expect(weekData).toHaveProperty("weekNumber");
          expect(weekData).toHaveProperty("inflationRewards");
          expect(weekData).toHaveProperty("protocolDepositRewards");
          expect(weekData).toHaveProperty("totalRewards");

          const weekInflation = BigInt(weekData.inflationRewards);
          const weekDeposit = BigInt(weekData.protocolDepositRewards);
          const weekTotal = BigInt(weekData.totalRewards);

          expect(weekTotal).toBe(weekInflation + weekDeposit);
        }

        console.log(`✓ Other farms rewards structure validated`);
      }
    });
  });

  describe("Wallet with both delegations and mining", () => {
    // This wallet should have at least 1 launchpad fraction AND 1 mining-center fraction
    const walletAddress = "0x5abcfde6bc010138f65e8dc088927473c49867e4";

    it("should return wallet with multiple delegations and mining activity", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.log(
          `Error for wallet ${walletAddress}: ${response.status} - ${errorText}`
        );
      }

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data).toHaveProperty("type", "wallet");
      expect(data).toHaveProperty("walletAddress", walletAddress.toLowerCase());

      expect(data.farmStatistics).toHaveProperty("totalFarms");
      expect(data.farmStatistics).toHaveProperty("delegatorOnlyFarms");
      expect(data.farmStatistics).toHaveProperty("minerOnlyFarms");
      expect(data.farmStatistics).toHaveProperty("bothTypesFarms");

      const hasDelegatorFarms =
        data.farmStatistics.delegatorOnlyFarms > 0 ||
        data.farmStatistics.bothTypesFarms > 0;
      const hasMinerFarms =
        data.farmStatistics.minerOnlyFarms > 0 ||
        data.farmStatistics.bothTypesFarms > 0;

      expect(hasDelegatorFarms).toBe(true);
      expect(hasMinerFarms).toBe(true);

      expect(Array.isArray(data.farmDetails)).toBe(true);

      const delegatorFarms = data.farmDetails.filter(
        (f: any) => f.type === "launchpad"
      );
      const minerFarms = data.farmDetails.filter(
        (f: any) => f.type === "mining-center"
      );

      expect(delegatorFarms.length).toBeGreaterThanOrEqual(1);
      expect(minerFarms.length).toBeGreaterThanOrEqual(1);

      const totalGlwDelegated = BigInt(data.totals.totalGlwDelegated);
      const totalUsdcSpent = BigInt(data.totals.totalUsdcSpentByMiners);

      expect(totalGlwDelegated).toBeGreaterThan(BigInt(0));
      expect(totalUsdcSpent).toBeGreaterThan(BigInt(0));

      const delegatorLastWeek = BigInt(data.rewards.delegator.lastWeek);
      const minerLastWeek = BigInt(data.rewards.miner.lastWeek);

      console.log(
        `✓ Wallet ${walletAddress} has both delegations and mining activity`
      );
      console.log(
        `✓ Farm statistics: ${data.farmStatistics.delegatorOnlyFarms} delegator-only, ${data.farmStatistics.minerOnlyFarms} miner-only, ${data.farmStatistics.bothTypesFarms} both types`
      );
      console.log(
        `✓ Delegator farms: ${delegatorFarms.length}, Miner farms: ${minerFarms.length}`
      );
      console.log(`✓ Total GLW delegated: ${data.totals.totalGlwDelegated}`);
      console.log(
        `✓ Total USDC spent by miners: ${data.totals.totalUsdcSpentByMiners}`
      );
      console.log(
        `✓ Delegator rewards (last week): ${data.rewards.delegator.lastWeek}`
      );
      console.log(
        `✓ Miner rewards (last week): ${data.rewards.miner.lastWeek}`
      );
    });

    it("should have valid APY for both delegator and miner", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      const data = await response.json();

      expect(data.apy).toHaveProperty("delegatorApyPercent");
      expect(data.apy).toHaveProperty("minerApyPercent");

      const delegatorApy = parseFloat(data.apy.delegatorApyPercent);
      const minerApy = parseFloat(data.apy.minerApyPercent);

      expect(delegatorApy).toBeGreaterThanOrEqual(0);
      expect(minerApy).toBeGreaterThanOrEqual(0);

      console.log(
        `✓ Delegator APY: ${data.apy.delegatorApyPercent}%, Miner APY: ${data.apy.minerApyPercent}%`
      );
    });

    it("should have detailed farm breakdowns for both types", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      const data = await response.json();

      const delegatorFarms = data.farmDetails.filter(
        (f: any) => f.type === "launchpad"
      );
      const minerFarms = data.farmDetails.filter(
        (f: any) => f.type === "mining-center"
      );

      for (const farm of delegatorFarms) {
        expect(farm).toHaveProperty("farmId");
        expect(farm).toHaveProperty("type", "launchpad");
        expect(farm).toHaveProperty("amountInvested");
        expect(farm).toHaveProperty("totalEarnedSoFar");
        expect(farm).toHaveProperty("totalInflationRewards");
        expect(farm).toHaveProperty("totalProtocolDepositRewards");
        expect(farm).toHaveProperty("weeklyBreakdown");

        const amountInvested = BigInt(farm.amountInvested);
        expect(amountInvested).toBeGreaterThan(BigInt(0));

        expect(Array.isArray(farm.weeklyBreakdown)).toBe(true);
      }

      for (const farm of minerFarms) {
        expect(farm).toHaveProperty("farmId");
        expect(farm).toHaveProperty("type", "mining-center");
        expect(farm).toHaveProperty("amountInvested");
        expect(farm).toHaveProperty("totalEarnedSoFar");
        expect(farm).toHaveProperty("totalInflationRewards");
        expect(farm).toHaveProperty("totalProtocolDepositRewards");
        expect(farm).toHaveProperty("weeklyBreakdown");

        const amountInvested = BigInt(farm.amountInvested);
        expect(amountInvested).toBeGreaterThan(BigInt(0));

        expect(Array.isArray(farm.weeklyBreakdown)).toBe(true);
      }

      console.log(`✓ Validated ${delegatorFarms.length} delegator farms`);
      console.log(`✓ Validated ${minerFarms.length} miner farms`);
    });

    it("should show correct investment totals for both types", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${walletAddress}`
      );

      const data = await response.json();

      const delegatorFarms = data.farmDetails.filter(
        (f: any) => f.type === "launchpad"
      );
      const minerFarms = data.farmDetails.filter(
        (f: any) => f.type === "mining-center"
      );

      let totalDelegatorInvestment = BigInt(0);
      for (const farm of delegatorFarms) {
        totalDelegatorInvestment += BigInt(farm.amountInvested);
      }

      let totalMinerInvestment = BigInt(0);
      for (const farm of minerFarms) {
        totalMinerInvestment += BigInt(farm.amountInvested);
      }

      const reportedDelegatorTotal = BigInt(data.totals.totalGlwDelegated);
      const reportedMinerTotal = BigInt(data.totals.totalUsdcSpentByMiners);

      expect(totalDelegatorInvestment).toBe(reportedDelegatorTotal);
      expect(totalMinerInvestment).toBe(reportedMinerTotal);

      console.log(
        `✓ Total delegator investment matches: ${totalDelegatorInvestment.toString()}`
      );
      console.log(
        `✓ Total miner investment matches: ${totalMinerInvestment.toString()}`
      );
    });
  });

  describe("Error handling", () => {
    it("should return 400 when no wallet or farm specified", async () => {
      const response = await fetch(`${BASE_URL}/fractions/rewards-breakdown`);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Either walletAddress or farmId must be provided");
    });

    it("should return error for invalid wallet address format", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=0xinvalid`
      );

      // Elysia's validation layer returns 500 for pattern mismatch
      // or the endpoint returns 400 if it reaches the manual validation
      expect([400, 500]).toContain(response.status);

      const text = await response.text();
      console.log(
        `✓ Invalid address rejected with status ${
          response.status
        }: ${text.substring(0, 100)}`
      );
    });

    it("should return 404 for wallet with no rewards", async () => {
      const nonExistentWallet = "0x0000000000000000000000000000000000000001";
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=${nonExistentWallet}`
      );

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toContain("Wallet not found or has no rewards");
    });

    it("should return 400 for invalid week range", async () => {
      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=0x5e230fed487c86b90f6508104149f087d9b1b0a7&startWeek=invalid`
      );

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid week range");
    });
  });

  describe("Performance", () => {
    it("should respond within reasonable time for wallet query", async () => {
      const startTime = Date.now();

      const response = await fetch(
        `${BASE_URL}/fractions/rewards-breakdown?walletAddress=0x5e230fed487c86b90f6508104149f087d9b1b0a7`
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(response.ok).toBe(true);

      console.log(`✓ Response time: ${duration}ms`);
      expect(duration).toBeLessThan(30000);
    });
  });
});
