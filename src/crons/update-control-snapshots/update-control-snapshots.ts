import pLimit from "p-limit";
import { and, gte, inArray, lte } from "drizzle-orm";
import { EXCLUDED_LEADERBOARD_WALLETS } from "../../constants/excluded-wallets";
import { db } from "../../db/db";
import {
  controlRegionRewardsWeek,
  controlWalletStakeByEpoch,
} from "../../db/schema";
import {
  fetchGctlStakersFromControlApi,
  fetchWalletStakeByEpochRange,
  getRegionRewardsAtEpoch,
} from "../../routers/impact-router/helpers/control-api";
import { getCurrentEpoch } from "../../utils/getProtocolWeek";

const DEFAULT_START_WEEK = 97;
const DEFAULT_WALLET_LOOKBACK_WEEKS = 5;
const DEFAULT_WALLET_WARM_CONCURRENCY = 8;
const DEFAULT_WALLET_WARM_LIMIT = 250;
const DEFAULT_REGION_CONCURRENCY = 3;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function normalizeWallets(wallets: string[]): string[] {
  return Array.from(
    new Set(
      wallets
        .map((wallet) => wallet.toLowerCase().trim())
        .filter((wallet) => /^0x[a-f0-9]{40}$/.test(wallet))
    )
  );
}

export async function updateControlSnapshots(params?: {
  startWeek?: number;
  endWeek?: number;
  includeWalletStakeWarm?: boolean;
  onlyMissingFinalized?: boolean;
}): Promise<{
  weekRange: { startWeek: number; endWeek: number };
  regionRewardsFetchedWeeks: number;
  walletStakeWarm: {
    enabled: boolean;
    startWeek: number;
    endWeek: number;
    walletCount: number;
    successCount: number;
    failureCount: number;
  };
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWeek = getCurrentEpoch(nowSec);
  const finalizedEndWeek = Math.max(DEFAULT_START_WEEK, currentWeek - 1);

  const startWeek = Math.max(
    DEFAULT_START_WEEK,
    params?.startWeek ?? DEFAULT_START_WEEK
  );
  const endWeek = Math.min(params?.endWeek ?? finalizedEndWeek, finalizedEndWeek);
  const onlyMissingFinalized = params?.onlyMissingFinalized ?? false;

  if (endWeek < startWeek) {
    return {
      weekRange: { startWeek, endWeek },
      regionRewardsFetchedWeeks: 0,
      walletStakeWarm: {
        enabled: false,
        startWeek,
        endWeek,
        walletCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };
  }

  const regionLimit = pLimit(
    parsePositiveIntEnv(
      process.env.CONTROL_SNAPSHOT_REGION_CONCURRENCY,
      DEFAULT_REGION_CONCURRENCY
    )
  );

  const regionTasks: Array<Promise<void>> = [];
  let regionRewardsFetchedWeeks = 0;
  const weeksToFetch: number[] = [];
  if (onlyMissingFinalized) {
    const existingWeekRows = await db
      .select({ weekNumber: controlRegionRewardsWeek.weekNumber })
      .from(controlRegionRewardsWeek)
      .where(
        and(
          gte(controlRegionRewardsWeek.weekNumber, startWeek),
          lte(controlRegionRewardsWeek.weekNumber, endWeek)
        )
      )
      .catch(() => []);
    const existingWeeks = new Set<number>(
      existingWeekRows.map((row) => row.weekNumber)
    );
    for (let week = startWeek; week <= endWeek; week++) {
      if (!existingWeeks.has(week)) weeksToFetch.push(week);
    }
  } else {
    for (let week = startWeek; week <= endWeek; week++) {
      weeksToFetch.push(week);
    }
  }

  for (const week of weeksToFetch) {
    regionTasks.push(
      regionLimit(async () => {
        try {
          await getRegionRewardsAtEpoch({ epoch: week });
          regionRewardsFetchedWeeks++;
        } catch (error) {
          console.warn(
            `[control-snapshot] region rewards sync failed (week=${week})`,
            error
          );
        }
      })
    );
  }
  await Promise.all(regionTasks);

  const includeWalletStakeWarm = params?.includeWalletStakeWarm ?? true;
  if (!includeWalletStakeWarm) {
    return {
      weekRange: { startWeek, endWeek },
      regionRewardsFetchedWeeks,
      walletStakeWarm: {
        enabled: false,
        startWeek,
        endWeek,
        walletCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };
  }

  const lookbackWeeks = parsePositiveIntEnv(
    process.env.CONTROL_SNAPSHOT_WALLET_LOOKBACK_WEEKS,
    DEFAULT_WALLET_LOOKBACK_WEEKS
  );
  const walletWarmStartWeek = Math.max(startWeek, endWeek - lookbackWeeks + 1);
  const walletWarmEndWeek = endWeek;
  if (walletWarmEndWeek < walletWarmStartWeek) {
    return {
      weekRange: { startWeek, endWeek },
      regionRewardsFetchedWeeks,
      walletStakeWarm: {
        enabled: true,
        startWeek: walletWarmStartWeek,
        endWeek: walletWarmEndWeek,
        walletCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };
  }

  const walletWarmLimit = parsePositiveIntEnv(
    process.env.CONTROL_SNAPSHOT_WALLET_WARM_LIMIT,
    DEFAULT_WALLET_WARM_LIMIT
  );
  const stakers = await fetchGctlStakersFromControlApi().catch((error) => {
    console.warn("[control-snapshot] failed to fetch stakers for warm-up", error);
    return { stakers: [] as string[], totalCount: 0 };
  });
  const normalizedFoundationWallets = normalizeWallets(EXCLUDED_LEADERBOARD_WALLETS);
  const normalizedStakerWallets = normalizeWallets(stakers.stakers).slice(
    0,
    walletWarmLimit
  );
  const wallets = normalizeWallets([
    ...normalizedFoundationWallets,
    ...normalizedStakerWallets,
  ]);

  const walletLimit = pLimit(
    parsePositiveIntEnv(
      process.env.CONTROL_SNAPSHOT_WALLET_CONCURRENCY,
      DEFAULT_WALLET_WARM_CONCURRENCY
    )
  );
  let walletsToSync = wallets;
  if (onlyMissingFinalized && wallets.length > 0) {
    const existingWalletRows = await db
      .select({
        wallet: controlWalletStakeByEpoch.wallet,
        weekNumber: controlWalletStakeByEpoch.weekNumber,
      })
      .from(controlWalletStakeByEpoch)
      .where(
        and(
          inArray(controlWalletStakeByEpoch.wallet, wallets),
          gte(controlWalletStakeByEpoch.weekNumber, walletWarmStartWeek),
          lte(controlWalletStakeByEpoch.weekNumber, walletWarmEndWeek)
        )
      )
      .catch(() => []);

    const weeksByWallet = new Map<string, Set<number>>();
    for (const row of existingWalletRows) {
      if (!weeksByWallet.has(row.wallet)) weeksByWallet.set(row.wallet, new Set());
      weeksByWallet.get(row.wallet)!.add(row.weekNumber);
    }
    const neededWeeks = walletWarmEndWeek - walletWarmStartWeek + 1;
    walletsToSync = wallets.filter(
      (wallet) => (weeksByWallet.get(wallet)?.size ?? 0) < neededWeeks
    );
  }

  let successCount = 0;
  let failureCount = 0;
  await Promise.all(
    walletsToSync.map((wallet) =>
      walletLimit(async () => {
        try {
          await fetchWalletStakeByEpochRange({
            walletAddress: wallet,
            startWeek: walletWarmStartWeek,
            endWeek: walletWarmEndWeek,
          });
          successCount++;
        } catch (error) {
          failureCount++;
          console.warn(
            `[control-snapshot] wallet stake sync failed (wallet=${wallet}, startWeek=${walletWarmStartWeek}, endWeek=${walletWarmEndWeek})`,
            error
          );
        }
      })
    )
  );

  return {
    weekRange: { startWeek, endWeek },
    regionRewardsFetchedWeeks,
    walletStakeWarm: {
      enabled: true,
      startWeek: walletWarmStartWeek,
      endWeek: walletWarmEndWeek,
      walletCount: walletsToSync.length,
      successCount,
      failureCount,
    },
  };
}
