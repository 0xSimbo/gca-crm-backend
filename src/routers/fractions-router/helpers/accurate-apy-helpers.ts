import { db } from "../../../db/db";
import { fractionSplits, fractions, applications } from "../../../db/schema";
import { eq, inArray, gt, lte, and } from "drizzle-orm";
import { getEpochEndDate } from "./apy-helpers";

interface FarmPurchase {
  farmId: string;
  appId: string;
  type: "launchpad" | "mining-center";
  amountInvested: bigint;
  stepsPurchased: number;
}

interface FarmAPYData {
  farmId: string;
  type: "launchpad" | "mining-center";
  amountInvested: bigint;
  firstWeekWithRewards: number;
  lastWeekRewards: bigint;
  totalWeeksEarned: number;
  totalEarnedSoFar: bigint;
  totalInflationRewards: bigint;
  totalProtocolDepositRewards: bigint;
  projectedTotalRewards: bigint;
  apy: number;
}

export async function getBatchWalletFarmPurchases(
  walletAddresses: string[]
): Promise<Map<string, FarmPurchase[]>> {
  if (walletAddresses.length === 0) {
    return new Map();
  }

  const normalizedWallets = walletAddresses.map((w) => w.toLowerCase());

  const purchases = await db
    .select({
      split: fractionSplits,
      fraction: fractions,
      application: applications,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .where(inArray(fractionSplits.buyer, normalizedWallets));

  const walletPurchasesMap = new Map<string, Map<string, FarmPurchase>>();

  for (const purchase of purchases) {
    const walletAddress = purchase.split.buyer.toLowerCase();
    const farmId = purchase.application.farmId;
    if (!farmId) continue;

    if (!walletPurchasesMap.has(walletAddress)) {
      walletPurchasesMap.set(walletAddress, new Map());
    }

    const farmPurchaseMap = walletPurchasesMap.get(walletAddress)!;
    const type =
      purchase.fraction.type === "mining-center"
        ? "mining-center"
        : "launchpad";
    const amount = BigInt(purchase.split.amount);
    const steps = purchase.split.stepsPurchased || 0;

    const key = `${farmId}-${type}`;

    if (!farmPurchaseMap.has(key)) {
      farmPurchaseMap.set(key, {
        farmId,
        appId: purchase.application.id,
        type,
        amountInvested: BigInt(0),
        stepsPurchased: 0,
      });
    }

    const existing = farmPurchaseMap.get(key)!;
    existing.amountInvested += amount;
    existing.stepsPurchased += steps;
  }

  const result = new Map<string, FarmPurchase[]>();
  for (const [wallet, purchaseMap] of walletPurchasesMap) {
    result.set(wallet, Array.from(purchaseMap.values()));
  }

  return result;
}

export async function getWalletFarmPurchases(
  walletAddress: string
): Promise<FarmPurchase[]> {
  const batchResult = await getBatchWalletFarmPurchases([walletAddress]);
  return batchResult.get(walletAddress.toLowerCase()) || [];
}

export async function getBatchPurchasesUpToWeek(
  walletAddresses: string[],
  upToWeek: number
): Promise<
  Map<
    string,
    {
      totalGlwDelegated: bigint;
      totalUsdcSpent: bigint;
    }
  >
> {
  if (walletAddresses.length === 0) {
    return new Map();
  }

  const epochEndDate = getEpochEndDate(upToWeek);
  const normalizedWallets = walletAddresses.map((w) => w.toLowerCase());

  const purchases = await db
    .select({
      split: fractionSplits,
      fraction: fractions,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, normalizedWallets),
        lte(fractionSplits.createdAt, epochEndDate)
      )
    );

  const result = new Map<
    string,
    {
      totalGlwDelegated: bigint;
      totalUsdcSpent: bigint;
    }
  >();

  for (const wallet of normalizedWallets) {
    result.set(wallet, {
      totalGlwDelegated: BigInt(0),
      totalUsdcSpent: BigInt(0),
    });
  }

  for (const purchase of purchases) {
    const wallet = purchase.split.buyer.toLowerCase();
    const existing = result.get(wallet)!;
    const amount = BigInt(purchase.split.amount);

    if (purchase.fraction.type === "launchpad") {
      existing.totalGlwDelegated += amount;
    } else if (purchase.fraction.type === "mining-center") {
      existing.totalUsdcSpent += amount;
    }
  }

  return result;
}

export async function getPurchasesUpToWeek(
  walletAddress: string,
  upToWeek: number
): Promise<{
  totalGlwDelegated: bigint;
  totalUsdcSpent: bigint;
}> {
  const batchResult = await getBatchPurchasesUpToWeek(
    [walletAddress],
    upToWeek
  );
  return (
    batchResult.get(walletAddress.toLowerCase()) || {
      totalGlwDelegated: BigInt(0),
      totalUsdcSpent: BigInt(0),
    }
  );
}

export async function getBatchPurchasesAfterWeek(
  walletAddresses: string[],
  afterWeek: number
): Promise<
  Map<
    string,
    {
      totalGlwDelegatedAfter: bigint;
      totalUsdcSpentAfter: bigint;
    }
  >
> {
  if (walletAddresses.length === 0) {
    return new Map();
  }

  const epochEndDate = getEpochEndDate(afterWeek);
  const normalizedWallets = walletAddresses.map((w) => w.toLowerCase());

  const purchases = await db
    .select({
      split: fractionSplits,
      fraction: fractions,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, normalizedWallets),
        gt(fractionSplits.createdAt, epochEndDate)
      )
    );

  const result = new Map<
    string,
    {
      totalGlwDelegatedAfter: bigint;
      totalUsdcSpentAfter: bigint;
    }
  >();

  for (const wallet of normalizedWallets) {
    result.set(wallet, {
      totalGlwDelegatedAfter: BigInt(0),
      totalUsdcSpentAfter: BigInt(0),
    });
  }

  for (const purchase of purchases) {
    const wallet = purchase.split.buyer.toLowerCase();
    const existing = result.get(wallet)!;
    const amount = BigInt(purchase.split.amount);

    if (purchase.fraction.type === "launchpad") {
      existing.totalGlwDelegatedAfter += amount;
    } else if (purchase.fraction.type === "mining-center") {
      existing.totalUsdcSpentAfter += amount;
    }
  }

  return result;
}

export async function getPurchasesAfterWeek(
  walletAddress: string,
  afterWeek: number
): Promise<{
  totalGlwDelegatedAfter: bigint;
  totalUsdcSpentAfter: bigint;
}> {
  const batchResult = await getBatchPurchasesAfterWeek(
    [walletAddress],
    afterWeek
  );
  return (
    batchResult.get(walletAddress.toLowerCase()) || {
      totalGlwDelegatedAfter: BigInt(0),
      totalUsdcSpentAfter: BigInt(0),
    }
  );
}

export async function getFarmPurchasesAfterWeek(
  farmId: string,
  afterWeek: number
): Promise<{
  totalGlwDelegatedAfter: bigint;
  totalUsdcSpentAfter: bigint;
}> {
  const epochEndDate = getEpochEndDate(afterWeek);

  const purchases = await db
    .select({
      split: fractionSplits,
      fraction: fractions,
      application: applications,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .where(
      and(
        eq(applications.farmId, farmId),
        gt(fractionSplits.createdAt, epochEndDate)
      )
    );

  let totalGlwDelegatedAfter = BigInt(0);
  let totalUsdcSpentAfter = BigInt(0);

  for (const purchase of purchases) {
    const amount = BigInt(purchase.split.amount);
    if (purchase.fraction.type === "launchpad") {
      totalGlwDelegatedAfter += amount;
    } else if (purchase.fraction.type === "mining-center") {
      totalUsdcSpentAfter += amount;
    }
  }

  return {
    totalGlwDelegatedAfter,
    totalUsdcSpentAfter,
  };
}

export function calculateFarmAPYFromRewards(
  farm: FarmPurchase,
  farmRewards: any[],
  endWeek: number,
  glwSpotPrice: number,
  fractionType: "launchpad" | "mining-center"
): FarmAPYData | null {
  let firstWeekWithRewards: number | null = null;
  let lastWeekRewards = BigInt(0);
  let totalWeeksEarned = 0;
  let totalEarnedSoFar = BigInt(0);
  let totalInflationRewards = BigInt(0);
  let totalProtocolDepositRewards = BigInt(0);

  for (const reward of farmRewards) {
    let inflationReward = BigInt(0);
    let depositReward = BigInt(0);

    if (fractionType === "launchpad") {
      inflationReward = BigInt(reward.walletInflationFromLaunchpad || "0");
      depositReward = BigInt(reward.walletProtocolDepositFromLaunchpad || "0");
    } else {
      inflationReward = BigInt(reward.walletInflationFromMiningCenter || "0");
      depositReward = BigInt(
        reward.walletProtocolDepositFromMiningCenter || "0"
      );
    }

    const totalReward = inflationReward + depositReward;

    if (totalReward > BigInt(0)) {
      if (firstWeekWithRewards === null) {
        firstWeekWithRewards = reward.weekNumber;
      }
      totalWeeksEarned++;
      totalEarnedSoFar += totalReward;
      totalInflationRewards += inflationReward;
      totalProtocolDepositRewards += depositReward;
      if (reward.weekNumber === endWeek) {
        lastWeekRewards = totalReward;
      }
    }
  }

  if (firstWeekWithRewards === null || lastWeekRewards === BigInt(0)) {
    return null;
  }

  const totalDurationWeeks = farm.type === "launchpad" ? 100 : 99;
  const projectedTotalRewards =
    totalWeeksEarned >= totalDurationWeeks
      ? totalEarnedSoFar
      : (totalEarnedSoFar * BigInt(totalDurationWeeks)) /
        BigInt(totalWeeksEarned);

  let apy = 0;

  if (farm.type === "launchpad") {
    const returnRatio =
      Number(projectedTotalRewards) / Number(farm.amountInvested);
    const annualizationFactor = 52.18 / totalDurationWeeks;
    apy = returnRatio * annualizationFactor * 100;
  } else if (farm.type === "mining-center" && glwSpotPrice > 0) {
    const projectedTotalEarnedInGLW = Number(projectedTotalRewards) / 1e18;
    const projectedTotalEarnedUsdc = projectedTotalEarnedInGLW * glwSpotPrice;
    const investedUsdc = Number(farm.amountInvested) / 1e6;

    const returnRatio = projectedTotalEarnedUsdc / investedUsdc;
    const annualizationFactor = 52.18 / totalDurationWeeks;
    apy = (returnRatio * annualizationFactor - 1) * 100;
  }

  return {
    farmId: farm.farmId,
    type: farm.type,
    amountInvested: farm.amountInvested,
    firstWeekWithRewards,
    lastWeekRewards,
    totalWeeksEarned,
    totalEarnedSoFar,
    totalInflationRewards,
    totalProtocolDepositRewards,
    projectedRemainingRewards: projectedTotalRewards - totalEarnedSoFar,
    projectedTotalRewards,
    apy,
  } as FarmAPYData;
}

export async function calculateAccurateWalletAPY(
  walletAddress: string,
  startWeek: number,
  endWeek: number,
  glwSpotPrice: number,
  farmRewardsData?: any[],
  farmPurchasesData?: FarmPurchase[]
): Promise<{
  delegatorAPY: number;
  minerAPY: number;
  farmBreakdowns: FarmAPYData[];
}> {
  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }

  const farmPurchases =
    farmPurchasesData || (await getWalletFarmPurchases(walletAddress));

  let allFarmRewards: any[] = [];

  if (farmRewardsData) {
    allFarmRewards = farmRewardsData;
  } else {
    try {
      const response = await fetch(
        `${process.env.CONTROL_API_URL}/farms/by-wallet/${walletAddress}/farm-rewards-history?startWeek=${startWeek}&endWeek=${endWeek}`
      );

      if (response.ok) {
        const data: any = await response.json();
        allFarmRewards = data.farmRewards || [];
      }
    } catch (error) {
      console.error("Failed to fetch farm rewards:", error);
    }
  }

  const delegatorFarms: FarmAPYData[] = [];
  const minerFarms: FarmAPYData[] = [];

  const farmsByFarmId = new Map<string, FarmPurchase[]>();
  for (const farm of farmPurchases) {
    if (!farmsByFarmId.has(farm.farmId)) {
      farmsByFarmId.set(farm.farmId, []);
    }
    farmsByFarmId.get(farm.farmId)!.push(farm);
  }

  for (const [farmId, farms] of farmsByFarmId) {
    const farmRewards = allFarmRewards.filter((r: any) => r.farmId === farmId);

    const hasLaunchpad = farms.some((f) => f.type === "launchpad");
    const hasMiningCenter = farms.some((f) => f.type === "mining-center");

    if (hasLaunchpad && hasMiningCenter) {
      const launchpadFarm = farms.find((f) => f.type === "launchpad")!;
      const miningCenterFarm = farms.find((f) => f.type === "mining-center")!;

      const delegatorAPYData = calculateFarmAPYFromRewards(
        launchpadFarm,
        farmRewards,
        endWeek,
        glwSpotPrice,
        "launchpad"
      );
      if (delegatorAPYData) {
        delegatorFarms.push(delegatorAPYData);
      }

      const minerAPYData = calculateFarmAPYFromRewards(
        miningCenterFarm,
        farmRewards,
        endWeek,
        glwSpotPrice,
        "mining-center"
      );
      if (minerAPYData) {
        minerFarms.push(minerAPYData);
      }
    } else {
      for (const farm of farms) {
        const apyData = calculateFarmAPYFromRewards(
          farm,
          farmRewards,
          endWeek,
          glwSpotPrice,
          farm.type
        );

        if (apyData) {
          if (farm.type === "launchpad") {
            delegatorFarms.push(apyData);
          } else {
            minerFarms.push(apyData);
          }
        }
      }
    }
  }

  let delegatorAPY = 0;
  if (delegatorFarms.length > 0) {
    const totalDelegated = delegatorFarms.reduce(
      (sum, f) => sum + f.amountInvested,
      BigInt(0)
    );
    const weightedAPYSum = delegatorFarms.reduce((sum, f) => {
      const weight = Number(f.amountInvested) / Number(totalDelegated);
      return sum + f.apy * weight;
    }, 0);
    delegatorAPY = weightedAPYSum;
  }

  let minerAPY = 0;
  if (minerFarms.length > 0) {
    const totalInvested = minerFarms.reduce(
      (sum, f) => sum + f.amountInvested,
      BigInt(0)
    );
    const weightedAPYSum = minerFarms.reduce((sum, f) => {
      const weight = Number(f.amountInvested) / Number(totalInvested);
      return sum + f.apy * weight;
    }, 0);
    minerAPY = weightedAPYSum;
  }

  return {
    delegatorAPY,
    minerAPY,
    farmBreakdowns: [...delegatorFarms, ...minerFarms],
  };
}
