import { db } from "../../../db/db";
import { fractions } from "../../../db/schema";
import { and, eq, inArray, lte } from "drizzle-orm";
import { FRACTION_STATUS } from "../../../constants/fractions";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";
import { getCachedGlwSpotPriceNumber } from "../../../utils/glw-spot";
import { getProtocolWeek } from "../../../utils/getProtocolWeek";

export interface WalletFarmInfo {
  walletAddress: string;
  farmId: string;
  appId: string;
  fractionTypes: ("launchpad" | "mining-center")[];
}

export interface WeekReward {
  weekNumber: number;
  glowInflationTotal: string;
  protocolDepositRewardsReceived: string;
}

export interface WalletRewards {
  walletAddress: string;
  rewards: WeekReward[];
}

export interface FractionTotals {
  totalGlwDelegated: bigint;
  totalMiningCenterVolume: bigint;
}

export interface RewardTotals {
  totalGlwEarnedByDelegatorsLastWeek: bigint;
  totalGlwEarnedByMinersLastWeek: bigint;
  totalGlwEarnedByDelegatorsAcrossAllWeeks: bigint;
  totalGlwEarnedByMinersAcrossAllWeeks: bigint;
}

export interface WalletRewardBreakdown {
  walletAddress: string;
  farmId: string;
  appId: string;
  fractionTypes: ("launchpad" | "mining-center")[];
  delegatorRewards: {
    lastWeek: bigint;
    allWeeks: bigint;
  };
  minerRewards: {
    lastWeek: bigint;
    allWeeks: bigint;
  };
}

export interface FarmRewardBreakdown {
  farmId: string;
  appId: string;
  fractionTypes: ("launchpad" | "mining-center")[];
  delegatorRewards: {
    lastWeek: bigint;
    allWeeks: bigint;
  };
  minerRewards: {
    lastWeek: bigint;
    allWeeks: bigint;
  };
  wallets: string[];
}

export function getWeekRange(): { startWeek: number; endWeek: number } {
  const lastCompletedWeek = getProtocolWeek() - 1;
  const startWeek = 97;
  const endWeek =
    lastCompletedWeek >= startWeek ? lastCompletedWeek : startWeek;
  return { startWeek, endWeek };
}

export function getEpochEndDate(endWeek: number): Date {
  const epochEndTimestamp = (endWeek + 1) * 604800 + GENESIS_TIMESTAMP;
  return new Date(epochEndTimestamp * 1000);
}

export async function getFilledFractionsUpToEpoch(epochEndDate: Date) {
  const result = await db
    .select({
      applicationId: fractions.applicationId,
      type: fractions.type,
      stepPrice: fractions.stepPrice,
      splitsSold: fractions.splitsSold,
    })
    .from(fractions)
    .where(
      and(
        eq(fractions.status, FRACTION_STATUS.FILLED),
        lte(fractions.filledAt, epochEndDate)
      )
    );

  return result.filter(
    (f): f is typeof f & { type: "launchpad" | "mining-center" } =>
      f.type === "launchpad" || f.type === "mining-center"
  );
}

export function calculateFractionTotals(
  filledFractions: Array<{
    applicationId: string;
    type: "launchpad" | "mining-center";
    stepPrice: string | null;
    splitsSold: number | null;
  }>,
  applicationIds?: string[]
): FractionTotals {
  let totalGlwDelegated = BigInt(0);
  let totalMiningCenterVolume = BigInt(0);

  for (const frac of filledFractions) {
    if (applicationIds && !applicationIds.includes(frac.applicationId)) {
      continue;
    }

    const stepPrice = frac.stepPrice ? BigInt(frac.stepPrice) : BigInt(0);
    const soldSteps = BigInt(frac.splitsSold ?? 0);
    if (soldSteps === BigInt(0)) continue;
    const total = stepPrice * soldSteps;

    if (frac.type === "launchpad") {
      totalGlwDelegated += total;
    } else if (frac.type === "mining-center") {
      totalMiningCenterVolume += total;
    }
  }

  return { totalGlwDelegated, totalMiningCenterVolume };
}

export async function buildWalletFarmMap(): Promise<
  Map<string, WalletFarmInfo[]>
> {
  const farmsWithApps = await db.query.farms.findMany({
    columns: { id: true },
    with: { application: { columns: { id: true } } },
  });

  const walletFarmMap = new Map<string, WalletFarmInfo[]>();
  const appIdByFarmId = new Map<string, string>();

  for (const f of farmsWithApps) {
    const appId = f.application?.id;
    if (appId) {
      appIdByFarmId.set(f.id, appId);
    }
  }

  const uniqueAppIds = Array.from(new Set(Array.from(appIdByFarmId.values())));

  const fractionTypesByAppId = new Map<
    string,
    Set<"launchpad" | "mining-center">
  >();
  if (uniqueAppIds.length > 0) {
    const fractionsForApps = await db
      .select({
        applicationId: fractions.applicationId,
        type: fractions.type,
      })
      .from(fractions)
      .where(
        and(
          inArray(fractions.applicationId, uniqueAppIds),
          eq(fractions.status, FRACTION_STATUS.FILLED)
        )
      );

    for (const frac of fractionsForApps) {
      if (frac.type === "launchpad" || frac.type === "mining-center") {
        if (!fractionTypesByAppId.has(frac.applicationId)) {
          fractionTypesByAppId.set(frac.applicationId, new Set());
        }
        fractionTypesByAppId.get(frac.applicationId)!.add(frac.type);
      }
    }
  }

  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }

  // Batch fetch reward splits with bounded concurrency
  const concurrency = 8;
  for (let i = 0; i < farmsWithApps.length; i += concurrency) {
    const batch = farmsWithApps.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (farm) => {
        const farmId = farm.id;
        const appId = appIdByFarmId.get(farmId);
        if (!appId) return;

        const fractionTypesSet = fractionTypesByAppId.get(appId) || new Set();
        const fractionTypes = Array.from(fractionTypesSet) as (
          | "launchpad"
          | "mining-center"
        )[];

        try {
          const rsResp = await fetch(
            `${process.env.CONTROL_API_URL}/farms/${farmId}/reward-splits`
          );
          if (!rsResp.ok) return;
          const rsJson: any = await rsResp.json();
          const splits: any[] = rsJson?.rewardSplits || [];
          for (const split of splits) {
            const walletAddress = split.walletAddress.toLowerCase();
            if (!walletFarmMap.has(walletAddress)) {
              walletFarmMap.set(walletAddress, []);
            }
            walletFarmMap.get(walletAddress)!.push({
              walletAddress,
              farmId,
              appId,
              fractionTypes,
            });
          }
        } catch {
          // skip on error
        }
      })
    );
  }

  return walletFarmMap;
}

export function classifyWalletType(
  farmInfos: WalletFarmInfo[]
): "delegator" | "miner" | "both" {
  const hasLaunchpad = farmInfos.some((info) =>
    info.fractionTypes.includes("launchpad")
  );
  const hasMiningCenter = farmInfos.some((info) =>
    info.fractionTypes.includes("mining-center")
  );

  if (hasLaunchpad && hasMiningCenter) {
    return "both";
  }
  return hasLaunchpad ? "delegator" : "miner";
}

export async function aggregateWalletRewards(
  walletAddress: string,
  farmInfos: WalletFarmInfo[],
  startWeek: number,
  endWeek: number
): Promise<{
  delegatorRewards: { lastWeek: bigint; allWeeks: bigint };
  minerRewards: { lastWeek: bigint; allWeeks: bigint };
}> {
  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }

  let delegatorRewardsLastWeek = BigInt(0);
  let delegatorRewardsAllWeeks = BigInt(0);
  let minerRewardsLastWeek = BigInt(0);
  let minerRewardsAllWeeks = BigInt(0);

  try {
    const response = await fetch(
      `${process.env.CONTROL_API_URL}/wallets/address/${walletAddress}/farm-rewards-history?startWeek=${startWeek}&endWeek=${endWeek}`
    );

    if (!response.ok) {
      return {
        delegatorRewards: { lastWeek: BigInt(0), allWeeks: BigInt(0) },
        minerRewards: { lastWeek: BigInt(0), allWeeks: BigInt(0) },
      };
    }

    const data: any = await response.json();
    const farmRewards = data.farmRewards || [];

    for (const reward of farmRewards) {
      const launchpadInflation = BigInt(reward.walletInflationFromLaunchpad || "0");
      const launchpadDeposit = BigInt(reward.walletProtocolDepositFromLaunchpad || "0");
      const miningCenterInflation = BigInt(reward.walletInflationFromMiningCenter || "0");
      const miningCenterDeposit = BigInt(reward.walletProtocolDepositFromMiningCenter || "0");

      const delegatorReward = launchpadInflation + launchpadDeposit;
      const minerReward = miningCenterInflation + miningCenterDeposit;

      delegatorRewardsAllWeeks += delegatorReward;
      minerRewardsAllWeeks += minerReward;

      if (reward.weekNumber === endWeek) {
        delegatorRewardsLastWeek += delegatorReward;
        minerRewardsLastWeek += minerReward;
      }
    }
  } catch (error) {
    return {
      delegatorRewards: { lastWeek: BigInt(0), allWeeks: BigInt(0) },
      minerRewards: { lastWeek: BigInt(0), allWeeks: BigInt(0) },
    };
  }

  return {
    delegatorRewards: {
      lastWeek: delegatorRewardsLastWeek,
      allWeeks: delegatorRewardsAllWeeks,
    },
    minerRewards: {
      lastWeek: minerRewardsLastWeek,
      allWeeks: minerRewardsAllWeeks,
    },
  };
}

export async function calculateTotalRewards(
  walletFarmMap: Map<string, WalletFarmInfo[]>,
  startWeek: number,
  endWeek: number,
  filterWalletAddress?: string,
  filterFarmId?: string
): Promise<{
  totals: RewardTotals;
  processedWalletCount: number;
  walletBreakdowns: WalletRewardBreakdown[];
}> {
  let totalGlwEarnedByDelegatorsLastWeek = BigInt(0);
  let totalGlwEarnedByMinersLastWeek = BigInt(0);
  let totalGlwEarnedByDelegatorsAcrossAllWeeks = BigInt(0);
  let totalGlwEarnedByMinersAcrossAllWeeks = BigInt(0);

  let processedWalletCount = 0;
  const walletBreakdowns: WalletRewardBreakdown[] = [];

  const entries: Array<[string, WalletFarmInfo[]]> = [];
  for (const [walletAddress, farmInfos] of walletFarmMap) {
    if (
      filterWalletAddress &&
      walletAddress !== filterWalletAddress.toLowerCase()
    ) {
      continue;
    }
    const filteredFarmInfos = filterFarmId
      ? farmInfos.filter((info) => info.farmId === filterFarmId)
      : farmInfos;
    if (filteredFarmInfos.length === 0) continue;
    entries.push([walletAddress, filteredFarmInfos]);
  }

  const concurrency = 8;
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async ([walletAddress, filteredFarmInfos]) => {
        const aggregated = await aggregateWalletRewards(
          walletAddress,
          filteredFarmInfos,
          startWeek,
          endWeek
        );

        const allFractionTypes = new Set<"launchpad" | "mining-center">();
        filteredFarmInfos.forEach((info) =>
          info.fractionTypes.forEach((t) => allFractionTypes.add(t))
        );

        return {
          walletAddress,
          farmId: filteredFarmInfos[0]?.farmId || "",
          appId: filteredFarmInfos[0]?.appId || "",
          fractionTypes: Array.from(allFractionTypes),
          aggregated,
        };
      })
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { walletAddress, farmId, appId, fractionTypes, aggregated } =
        r.value;
      totalGlwEarnedByDelegatorsLastWeek +=
        aggregated.delegatorRewards.lastWeek;
      totalGlwEarnedByMinersLastWeek += aggregated.minerRewards.lastWeek;
      totalGlwEarnedByDelegatorsAcrossAllWeeks +=
        aggregated.delegatorRewards.allWeeks;
      totalGlwEarnedByMinersAcrossAllWeeks += aggregated.minerRewards.allWeeks;
      walletBreakdowns.push({
        walletAddress,
        farmId,
        appId,
        fractionTypes,
        delegatorRewards: aggregated.delegatorRewards,
        minerRewards: aggregated.minerRewards,
      });
      processedWalletCount++;
    }
  }

  return {
    totals: {
      totalGlwEarnedByDelegatorsLastWeek,
      totalGlwEarnedByMinersLastWeek,
      totalGlwEarnedByDelegatorsAcrossAllWeeks,
      totalGlwEarnedByMinersAcrossAllWeeks,
    },
    processedWalletCount,
    walletBreakdowns,
  };
}

export function calculateDelegatorApy(
  totalGlwEarnedByDelegatorsLastWeek: bigint,
  totalGlwDelegated: bigint
): string {
  if (totalGlwDelegated === BigInt(0)) {
    return "0";
  }

  const ratioScaled6 =
    (totalGlwEarnedByDelegatorsLastWeek * BigInt(1_000_000)) /
    totalGlwDelegated;
  const apyScaled6 = (ratioScaled6 * BigInt(5218)) / BigInt(100);
  return apyScaled6.toString();
}

export function calculateMinerApyPercent(
  totalGlwEarnedByMinersLastWeek: bigint,
  totalMiningCenterVolume: bigint,
  glwSpotPrice: number
): string {
  if (totalMiningCenterVolume === BigInt(0)) {
    return "0";
  }

  if (glwSpotPrice <= 0) {
    return "0";
  }

  const glwEarnedUsdc6 =
    (totalGlwEarnedByMinersLastWeek *
      BigInt(Math.round(glwSpotPrice * 1_000_000))) /
    BigInt(1_000_000_000_000_000_000);

  const annualizedUsdc6 = (glwEarnedUsdc6 * BigInt(5218)) / BigInt(100);

  const ratioScaled6 =
    (annualizedUsdc6 * BigInt(1_000_000)) / totalMiningCenterVolume;
  const percentScaled6 = (ratioScaled6 - BigInt(1_000_000)) * BigInt(100);

  return percentScaled6.toString();
}

export function aggregateRewardsByFarm(
  walletBreakdowns: WalletRewardBreakdown[]
): Map<string, FarmRewardBreakdown> {
  const farmMap = new Map<string, FarmRewardBreakdown>();

  for (const breakdown of walletBreakdowns) {
    const key = breakdown.farmId;
    if (!farmMap.has(key)) {
      const existingFractionTypes = new Set<"launchpad" | "mining-center">();
      for (const existing of walletBreakdowns) {
        if (existing.farmId === breakdown.farmId) {
          existing.fractionTypes.forEach((t) => existingFractionTypes.add(t));
        }
      }
      farmMap.set(key, {
        farmId: breakdown.farmId,
        appId: breakdown.appId,
        fractionTypes: Array.from(existingFractionTypes),
        delegatorRewards: {
          lastWeek: BigInt(0),
          allWeeks: BigInt(0),
        },
        minerRewards: {
          lastWeek: BigInt(0),
          allWeeks: BigInt(0),
        },
        wallets: [],
      });
    }

    const farmData = farmMap.get(key)!;
    farmData.delegatorRewards.lastWeek += breakdown.delegatorRewards.lastWeek;
    farmData.delegatorRewards.allWeeks += breakdown.delegatorRewards.allWeeks;
    farmData.minerRewards.lastWeek += breakdown.minerRewards.lastWeek;
    farmData.minerRewards.allWeeks += breakdown.minerRewards.allWeeks;

    if (!farmData.wallets.includes(breakdown.walletAddress)) {
      farmData.wallets.push(breakdown.walletAddress);
    }
  }

  return farmMap;
}

export function aggregateRewardsByWallet(
  walletBreakdowns: WalletRewardBreakdown[]
): Map<string, WalletRewardBreakdown> {
  const walletMap = new Map<string, WalletRewardBreakdown>();

  for (const breakdown of walletBreakdowns) {
    const key = breakdown.walletAddress;
    if (!walletMap.has(key)) {
      const existingFractionTypes = new Set<"launchpad" | "mining-center">();
      for (const existing of walletBreakdowns) {
        if (existing.walletAddress === breakdown.walletAddress) {
          existing.fractionTypes.forEach((t) => existingFractionTypes.add(t));
        }
      }
      walletMap.set(key, {
        walletAddress: breakdown.walletAddress,
        farmId: breakdown.farmId,
        appId: breakdown.appId,
        fractionTypes: Array.from(existingFractionTypes),
        delegatorRewards: breakdown.delegatorRewards,
        minerRewards: breakdown.minerRewards,
      });
    }
  }

  return walletMap;
}
