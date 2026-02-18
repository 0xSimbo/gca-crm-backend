import { and, eq, inArray, gte, lte, or, isNull, sql } from "drizzle-orm";

import { db } from "../../../db/db";
import { addresses } from "../../../constants/addresses";
import {
  EXCLUDED_LEADERBOARD_WALLETS,
  excludedLeaderboardWalletsSet,
} from "../../../constants/excluded-wallets";
import {
  fractionRefunds,
  fractionSplits,
  fractions,
  applications,
  RewardSplits,
  gctlStakedByRegionWeek,
  controlWalletStakeByEpoch,
  controlRegionRewardsWeek,
  gctlMintEvents,
} from "../../../db/schema";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getWeekRange } from "../../fractions-router/helpers/apy-helpers";
import { getLiquidGlwBalancesWeiBatch } from "./glw-balance";
import {
  fetchDepositSplitsHistoryBatch,
  fetchFarmRewardsHistoryBatch,
  fetchWalletRewardsHistoryBatch,
  fetchGlwHoldersFromPonder,
  fetchGlwBalanceSnapshotByWeekMany,
  fetchGctlStakersFromControlApi,
  fetchClaimedPdWeeksBatch,
  fetchClaimsBatch,
  fetchWalletWeeklyRewards,
  fetchWalletStakeByEpochRange,
  getGctlSteeringByWeekWei,
  getSteeringSnapshot,
  getUnclaimedGlwRewardsWei,
  getRegionRewardsAtEpoch,
  type GlwBalanceSnapshotSource,
  type ControlApiFarmReward,
  type ControlApiDepositSplitHistorySegment,
  type ControlApiFarmRewardsHistoryRewardRow,
  type SteeringByWeekResult,
  type RegionRewardsResponse,
  type ControlApiWalletWeeklyRewardRow,
} from "./control-api";
import {
  addScaled6Points,
  clampToZero,
  formatPointsScaled6,
  glwWeiToPointsScaled6,
  GLW_DECIMALS,
} from "./points";

const BATCH_SIZE = 500;
const FARM_REWARDS_BATCH_SIZE = 100;
const FARM_REWARDS_BATCH_CONCURRENCY = 3;
const DELEGATION_START_WEEK = 97;
const ZERO_POINTS_SCALED6 = formatPointsScaled6(0n);
const ZERO_WEI_STRING = "0";

export interface ImpactTimingEvent {
  label: string;
  ms: number;
  meta?: Record<string, unknown>;
}

export interface ImpactTimingCollector {
  requestId: string;
  recordTiming: (event: ImpactTimingEvent) => void;
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function recordTimingSafe(
  collector: ImpactTimingCollector | undefined,
  event: ImpactTimingEvent
) {
  if (!collector) return;
  try {
    collector.recordTiming(event);
  } catch {
    // swallow instrumentation errors
  }
}

function zeroOutImpactScoreResult(
  result: GlowImpactScoreResult
): GlowImpactScoreResult {
  result.pointsPerRegion = {};
  if (result.regionBreakdown) result.regionBreakdown = [];
  if (result.weeklyRegionBreakdown) result.weeklyRegionBreakdown = [];

  result.totals = {
    totalPoints: ZERO_POINTS_SCALED6,
    rolloverPoints: ZERO_POINTS_SCALED6,
    continuousPoints: ZERO_POINTS_SCALED6,
    inflationPoints: ZERO_POINTS_SCALED6,
    steeringPoints: ZERO_POINTS_SCALED6,
    vaultBonusPoints: ZERO_POINTS_SCALED6,
    worthPoints: ZERO_POINTS_SCALED6,
    basePointsPreMultiplierScaled6: ZERO_POINTS_SCALED6,
    basePointsPreMultiplierScaled6ThisWeek: ZERO_POINTS_SCALED6,
    totalInflationGlwWei: ZERO_WEI_STRING,
    totalSteeringGlwWei: ZERO_WEI_STRING,
  };

  result.composition = {
    steeringPoints: ZERO_POINTS_SCALED6,
    inflationPoints: ZERO_POINTS_SCALED6,
    worthPoints: ZERO_POINTS_SCALED6,
    vaultPoints: ZERO_POINTS_SCALED6,
    referralPoints: ZERO_POINTS_SCALED6,
    referralBonusPoints: ZERO_POINTS_SCALED6,
  };

  result.lastWeekPoints = ZERO_POINTS_SCALED6;
  result.activeMultiplier = false;
  result.hasMinerMultiplier = false;
  result.endWeekMultiplier = 1;

  if (result.weekly && result.weekly.length > 0) {
    result.weekly = result.weekly.map((row) => ({
      ...row,
      inflationPoints: ZERO_POINTS_SCALED6,
      steeringPoints: ZERO_POINTS_SCALED6,
      vaultBonusPoints: ZERO_POINTS_SCALED6,
      rolloverPointsPreMultiplier: ZERO_POINTS_SCALED6,
      rolloverMultiplier: 1,
      rolloverPoints: ZERO_POINTS_SCALED6,
      continuousPoints: ZERO_POINTS_SCALED6,
      totalPoints: ZERO_POINTS_SCALED6,
      hasCashMinerBonus: false,
      baseMultiplier: 1,
      streakBonusMultiplier: 0,
      impactStreakWeeks: 0,
      pointsPerRegion: {},
    }));
  }

  return result;
}

async function timePromise<T>(
  collector: ImpactTimingCollector | undefined,
  label: string,
  promise: Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const start = nowMs();
  try {
    const value = await promise;
    recordTimingSafe(collector, { label, ms: nowMs() - start, meta });
    return value;
  } catch (error) {
    recordTimingSafe(collector, {
      label,
      ms: nowMs() - start,
      meta: {
        ...(meta || {}),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

const INFLATION_POINTS_PER_GLW_SCALED6 = BigInt(1_000_000); // +1.0 per GLW
const STEERING_POINTS_PER_GLW_SCALED6 = BigInt(3_000_000); // +3.0 per GLW
const VAULT_BONUS_POINTS_PER_GLW_SCALED6 = BigInt(5_000); // +0.005 per GLW per week
const GLOW_WORTH_POINTS_PER_GLW_SCALED6 = BigInt(1_000); // +0.001 per GLW per week

const MULTIPLIER_SCALE_SCALED6 = BigInt(1_000_000);
const BASE_STANDARD_MULTIPLIER_SCALED6 = BigInt(1_000_000); // 1.0x
const BASE_CASH_MINER_MULTIPLIER_SCALED6 = BigInt(3_000_000); // 3.0x
const STREAK_BONUS_PER_WEEK_SCALED6 = BigInt(250_000); // +0.25x
const STREAK_BONUS_CAP_WEEKS = 4;
const SPLIT_SCALE_SCALED6 = BigInt(1_000_000);
export function getStreakBonusMultiplierScaled6(streakWeeks: number): bigint {
  if (streakWeeks <= 0) return BigInt(0);
  const effectiveWeeks = Math.min(streakWeeks, STREAK_BONUS_CAP_WEEKS);
  return BigInt(effectiveWeeks) * STREAK_BONUS_PER_WEEK_SCALED6;
}

export function applyMultiplierScaled6(params: {
  pointsScaled6: bigint;
  multiplierScaled6: bigint;
}): bigint {
  const { pointsScaled6, multiplierScaled6 } = params;
  if (pointsScaled6 <= BigInt(0)) return BigInt(0);
  if (multiplierScaled6 <= BigInt(0)) return BigInt(0);
  return (pointsScaled6 * multiplierScaled6) / MULTIPLIER_SCALE_SCALED6;
}

type RegionRewardsAggregateByWeek = Map<
  number,
  { totalGlw: bigint; byRegion: Map<number, bigint>; totalGctlStaked: bigint }
>;
type WalletStakeByWeek = Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>;
type WalletStakeByWallet = Map<string, WalletStakeByWeek>;

async function loadDbGctlStakeByRegionByWeek(params: {
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, Map<number, bigint>>> {
  const rows = await db
    .select({
      weekNumber: gctlStakedByRegionWeek.weekNumber,
      region: gctlStakedByRegionWeek.region,
      gctlStakedRaw: gctlStakedByRegionWeek.gctlStakedRaw,
    })
    .from(gctlStakedByRegionWeek)
    .where(
      and(
        gte(gctlStakedByRegionWeek.weekNumber, params.startWeek),
        lte(gctlStakedByRegionWeek.weekNumber, params.endWeek)
      )
    );

  const byWeek = new Map<number, Map<number, bigint>>();
  for (const row of rows) {
    const regionId = Number(row.region);
    if (!Number.isFinite(regionId)) continue;
    let staked = 0n;
    try {
      staked = BigInt(String(row.gctlStakedRaw ?? "0"));
    } catch {
      staked = 0n;
    }
    if (!byWeek.has(row.weekNumber)) byWeek.set(row.weekNumber, new Map());
    byWeek.get(row.weekNumber)!.set(regionId, staked);
  }
  return byWeek;
}

async function loadControlRegionRewardsByWeekFromDb(params: {
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, RegionRewardsResponse>> {
  const rows = await db
    .select({
      weekNumber: controlRegionRewardsWeek.weekNumber,
      regionId: controlRegionRewardsWeek.regionId,
      glwRewardRaw: controlRegionRewardsWeek.glwRewardRaw,
      gctlStakedRaw: controlRegionRewardsWeek.gctlStakedRaw,
      rewardShareRaw: controlRegionRewardsWeek.rewardShareRaw,
    })
    .from(controlRegionRewardsWeek)
    .where(
      and(
        gte(controlRegionRewardsWeek.weekNumber, params.startWeek),
        lte(controlRegionRewardsWeek.weekNumber, params.endWeek)
      )
    );

  const byWeek = new Map<
    number,
    { regionRewards: RegionRewardsResponse["regionRewards"]; totalGlw: bigint; totalGctl: bigint }
  >();
  for (const row of rows) {
    if (!byWeek.has(row.weekNumber)) {
      byWeek.set(row.weekNumber, {
        regionRewards: [],
        totalGlw: 0n,
        totalGctl: 0n,
      });
    }
    const bucket = byWeek.get(row.weekNumber)!;
    const glw = safeBigInt(row.glwRewardRaw);
    const gctl = safeBigInt(row.gctlStakedRaw);

    if (row.regionId > 0) {
      bucket.regionRewards.push({
        regionId: row.regionId,
        gctlStaked: gctl.toString(),
        glwReward: glw.toString(),
        rewardShare: String(row.rewardShareRaw ?? "0"),
      });
    }

    if (glw > 0n) bucket.totalGlw += glw;
    if (gctl > 0n) bucket.totalGctl += gctl;
  }

  const out = new Map<number, RegionRewardsResponse>();
  for (const [week, bucket] of byWeek) {
    out.set(week, {
      totalGctlStaked: bucket.totalGctl.toString(),
      totalGlwRewards: bucket.totalGlw.toString(),
      regionRewards: bucket.regionRewards,
    });
  }
  return out;
}

async function loadWalletStakeByEpochFromDbMany(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<{
  byWallet: WalletStakeByWallet;
  coveredWallets: Set<string>;
  missingWallets: string[];
}> {
  const normalizedWallets = Array.from(
    new Set(params.wallets.map((w) => w.toLowerCase()).filter(Boolean))
  );
  const byWallet: WalletStakeByWallet = new Map();
  const coveredWeeksByWallet = new Map<string, Set<number>>();
  for (const wallet of normalizedWallets) {
    const byWeek: WalletStakeByWeek = new Map();
    for (let week = params.startWeek; week <= params.endWeek; week++) {
      byWeek.set(week, []);
    }
    byWallet.set(wallet, byWeek);
    coveredWeeksByWallet.set(wallet, new Set());
  }

  if (normalizedWallets.length === 0) {
    return { byWallet, coveredWallets: new Set(), missingWallets: [] };
  }

  const rows = await db
    .select({
      wallet: controlWalletStakeByEpoch.wallet,
      weekNumber: controlWalletStakeByEpoch.weekNumber,
      regionId: controlWalletStakeByEpoch.regionId,
      totalStakedRaw: controlWalletStakeByEpoch.totalStakedRaw,
    })
    .from(controlWalletStakeByEpoch)
    .where(
      and(
        inArray(controlWalletStakeByEpoch.wallet, normalizedWallets),
        gte(controlWalletStakeByEpoch.weekNumber, params.startWeek),
        lte(controlWalletStakeByEpoch.weekNumber, params.endWeek)
      )
    );

  for (const row of rows) {
    const wallet = (row.wallet || "").toLowerCase();
    const byWeek = byWallet.get(wallet);
    if (!byWeek) continue;
    coveredWeeksByWallet.get(wallet)?.add(row.weekNumber);
    if (row.regionId <= 0) continue;
    const stakeRows = byWeek.get(row.weekNumber);
    if (!stakeRows) continue;
    stakeRows.push({
      regionId: row.regionId,
      totalStakedWei: safeBigInt(row.totalStakedRaw),
    });
  }

  const coveredWallets = new Set<string>();
  const missingWallets: string[] = [];
  for (const wallet of normalizedWallets) {
    const coveredWeeks = coveredWeeksByWallet.get(wallet) || new Set<number>();
    let isCovered = true;
    for (let week = params.startWeek; week <= params.endWeek; week++) {
      if (!coveredWeeks.has(week)) {
        isCovered = false;
        break;
      }
    }
    if (isCovered) coveredWallets.add(wallet);
    else missingWallets.push(wallet);
  }

  return { byWallet, coveredWallets, missingWallets };
}

function toRegionRewardsAggregate(params: {
  rewards: RegionRewardsResponse;
  dbStakeByRegion?: Map<number, bigint>;
}): {
  totalGlw: bigint;
  byRegion: Map<number, bigint>;
  totalGctlStaked: bigint;
} {
  const byRegion = new Map<number, bigint>();
  let totalGlw = 0n;
  let totalGctlStaked = 0n;
  for (const r of params.rewards.regionRewards || []) {
    const glw = BigInt(r.glwReward || "0");
    const controlStake = BigInt(r.gctlStaked || "0");
    const dbStake = params.dbStakeByRegion?.get(r.regionId);
    // Prefer Control stake when present; only fall back to DB snapshot for finalized historical rows that came back as zero/missing.
    const gctl =
      controlStake > 0n
        ? controlStake
        : dbStake && dbStake > 0n
          ? dbStake
          : controlStake;

    if (glw > 0n) {
      byRegion.set(r.regionId, glw);
      totalGlw += glw;
    }
    if (gctl > 0n) totalGctlStaked += gctl;
  }

  return { totalGlw, byRegion, totalGctlStaked };
}

async function loadRegionRewardsByWeek(params: {
  startWeek: number;
  endWeek: number;
  debug?: ImpactTimingCollector;
}): Promise<{
  rawByWeek: Map<number, RegionRewardsResponse>;
  aggregateByWeek: RegionRewardsAggregateByWeek;
}> {
  const dbStakeStart = nowMs();
  const dbStakeByWeek = await loadDbGctlStakeByRegionByWeek({
    startWeek: params.startWeek,
    endWeek: params.endWeek,
  }).catch((error) => {
    console.error("[impact-score] failed to load DB gctl stake snapshots", error);
    return new Map<number, Map<number, bigint>>();
  });
  recordTimingSafe(params.debug, {
    label: "compute.regionRewards.dbStakeLookup",
    ms: nowMs() - dbStakeStart,
    meta: {
      weeks: params.endWeek - params.startWeek + 1,
      weeksWithStakeSnapshot: dbStakeByWeek.size,
    },
  });

  const rawByWeek = new Map<number, RegionRewardsResponse>();
  const aggregateByWeek: RegionRewardsAggregateByWeek = new Map();
  const dbRewardsStart = nowMs();
  const dbRewardsByWeek = await loadControlRegionRewardsByWeekFromDb({
    startWeek: params.startWeek,
    endWeek: params.endWeek,
  }).catch((error) => {
    console.error("[impact-score] failed to load DB control region rewards", error);
    return new Map<number, RegionRewardsResponse>();
  });
  recordTimingSafe(params.debug, {
    label: "compute.regionRewards.dbRewardsLookup",
    ms: nowMs() - dbRewardsStart,
    meta: {
      weeks: params.endWeek - params.startWeek + 1,
      weeksWithRewardSnapshot: dbRewardsByWeek.size,
    },
  });

  const finalizedWeek = getWeekRange().endWeek;
  const missingWeeks: number[] = [];
  for (let w = params.startWeek; w <= params.endWeek; w++) {
    if (!dbRewardsByWeek.has(w) && w <= finalizedWeek) missingWeeks.push(w);
  }

  const fetchedMissingRewards = new Map<number, RegionRewardsResponse>();
  if (missingWeeks.length > 0) {
    await Promise.all(
      missingWeeks.map(async (week) => {
        try {
          const rewards = await getRegionRewardsAtEpoch({ epoch: week });
          fetchedMissingRewards.set(week, rewards);
        } catch (error) {
          console.error(
            `[impact-score] failed to fetch region rewards for week ${week}`,
            error
          );
        }
      })
    );
  }

  for (let w = params.startWeek; w <= params.endWeek; w++) {
    const rewards = dbRewardsByWeek.get(w) || fetchedMissingRewards.get(w);
    if (!rewards) continue;
    rawByWeek.set(w, rewards);
    aggregateByWeek.set(
      w,
      toRegionRewardsAggregate({
        rewards,
        dbStakeByRegion: dbStakeByWeek.get(w),
      })
    );
  }

  return { rawByWeek, aggregateByWeek };
}

export function computeSteeringBoostScaled6(params: {
  totalStakedWei: bigint;
  foundationStakedWei: bigint;
}): bigint {
  const { totalStakedWei, foundationStakedWei } = params;
  if (totalStakedWei <= 0n) return MULTIPLIER_SCALE_SCALED6;
  if (foundationStakedWei <= 0n) return MULTIPLIER_SCALE_SCALED6;
  if (foundationStakedWei >= totalStakedWei) return MULTIPLIER_SCALE_SCALED6;

  const userStakedWei = totalStakedWei - foundationStakedWei;
  if (userStakedWei <= 0n) return MULTIPLIER_SCALE_SCALED6;
  return (totalStakedWei * MULTIPLIER_SCALE_SCALED6) / userStakedWei;
}

export function normalizeFoundationWallets(wallets: string[]): string[] {
  return Array.from(
    new Set(wallets.map((w) => w.toLowerCase()).filter(Boolean))
  ).sort();
}

async function getSteeringBoostByWeek(params: {
  startWeek: number;
  endWeek: number;
  foundationWallets: string[];
  regionRewardsByWeek?: Map<
    number,
    { totalGlw: bigint; byRegion: Map<number, bigint>; totalGctlStaked: bigint }
  >;
  debug?: ImpactTimingCollector;
}): Promise<Map<number, bigint>> {
  const { startWeek, endWeek, foundationWallets, regionRewardsByWeek, debug } =
    params;

  if (!foundationWallets || foundationWallets.length === 0) return new Map();

  // Dedupe to avoid double-counting stake when an excluded wallet appears
  // both as a static literal and as an env-derived constant (e.g. ENDOWMENT_WALLET).
  const normalizedWallets = normalizeFoundationWallets(foundationWallets);
  if (normalizedWallets.length === 0) return new Map();

  const boostsByWeek = new Map<number, bigint>();

  const regionRewards =
    regionRewardsByWeek ??
    (await (async () => {
      const map = new Map<
        number,
        {
          totalGlw: bigint;
          byRegion: Map<number, bigint>;
          totalGctlStaked: bigint;
        }
      >();
      for (let w = startWeek; w <= endWeek; w++) {
        try {
          const rr = await getRegionRewardsAtEpoch({ epoch: w });
          const byRegion = new Map<number, bigint>();
          let total = 0n;
          let totalGctlStaked = 0n;
          for (const r of rr.regionRewards || []) {
            const glw = BigInt(r.glwReward || "0");
            const gctl = BigInt(r.gctlStaked || "0");
            if (glw > 0n) {
              byRegion.set(r.regionId, glw);
              total += glw;
            }
            if (gctl > 0n) totalGctlStaked += gctl;
          }
          map.set(w, {
            totalGlw: total,
            byRegion,
            totalGctlStaked,
          });
        } catch (e) {
          console.error(
            `[impact-score] failed to fetch region rewards for steering boost (week ${w})`,
            e
          );
        }
      }
      return map;
    })());

  const foundationStakeByWeek = new Map<number, bigint>();
  const foundationStart = nowMs();
  const stakeByWallet = await loadWalletStakeByEpochFromDbMany({
    wallets: normalizedWallets,
    startWeek,
    endWeek,
  }).catch((error) => {
    console.error(
      "[impact-score] failed to load foundation stake snapshots from DB",
      error
    );
    return {
      byWallet: new Map<string, WalletStakeByWeek>(),
      coveredWallets: new Set<string>(),
      missingWallets: normalizedWallets,
    };
  });

  const addStakeByWeek = (stakeMap: WalletStakeByWeek) => {
    for (const [week, regions] of stakeMap) {
      const totalForWeek = regions.reduce(
        (sum: bigint, r: { totalStakedWei: bigint }) => sum + r.totalStakedWei,
        0n
      );
      if (totalForWeek <= 0n) continue;
      foundationStakeByWeek.set(
        week,
        (foundationStakeByWeek.get(week) || 0n) + totalForWeek
      );
    }
  };

  for (const wallet of stakeByWallet.coveredWallets) {
    addStakeByWeek(stakeByWallet.byWallet.get(wallet) || new Map());
  }

  if (stakeByWallet.missingWallets.length > 0) {
    const fallbackStakeRows = await Promise.all(
      stakeByWallet.missingWallets.map(async (wallet) => {
        try {
          const stakeByWeek = await fetchWalletStakeByEpochRange({
            walletAddress: wallet,
            startWeek,
            endWeek,
          });
          return { wallet, stakeByWeek };
        } catch (error) {
          console.error(
            `[impact-score] foundation stake fetch failed for wallet=${wallet}`,
            error
          );
          return { wallet, stakeByWeek: new Map() };
        }
      })
    );

    for (const row of fallbackStakeRows) addStakeByWeek(row.stakeByWeek);
  }

  recordTimingSafe(debug, {
    label: "compute.steeringBoost.foundationStake",
    ms: nowMs() - foundationStart,
    meta: {
      wallets: normalizedWallets.length,
      weeks: endWeek - startWeek + 1,
      dbCoveredWallets: stakeByWallet.coveredWallets.size,
      fallbackWallets: stakeByWallet.missingWallets.length,
    },
  });

  for (let w = startWeek; w <= endWeek; w++) {
    const regionRewardsRow = regionRewards.get(w);
    const totalGctlStaked = regionRewardsRow?.totalGctlStaked ?? 0n;
    const foundationStaked = foundationStakeByWeek.get(w) ?? 0n;
    const boost = computeSteeringBoostScaled6({
      totalStakedWei: totalGctlStaked,
      foundationStakedWei: foundationStaked,
    });
    if (boost !== MULTIPLIER_SCALE_SCALED6) boostsByWeek.set(w, boost);
  }

  return boostsByWeek;
}

function isHexWallet(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isGlwAsset(asset: string | null | undefined): boolean {
  return (asset || "").toUpperCase() === "GLW";
}

function protocolDepositReceivedGlwWei(params: {
  amountRaw: bigint;
  asset: string | null | undefined;
}): bigint {
  const { amountRaw, asset } = params;
  if (amountRaw <= BigInt(0)) return BigInt(0);
  return isGlwAsset(asset) ? amountRaw : BigInt(0);
}

function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return BigInt(0);
  } catch {
    return BigInt(0);
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

async function mapChunksWithConcurrency<T>(params: {
  items: T[];
  chunkSize: number;
  concurrency: number;
  worker: (chunk: T[]) => Promise<void>;
}): Promise<void> {
  const { items, chunkSize, worker } = params;
  const chunks = chunkArray(items, chunkSize);
  if (chunks.length === 0) return;

  const workerCount = Math.max(
    1,
    Math.min(params.concurrency, chunks.length)
  );
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, () =>
    (async () => {
      for (;;) {
        const index = cursor++;
        if (index >= chunks.length) break;
        await worker(chunks[index]!);
      }
    })()
  );

  await Promise.all(workers);
}

function getFinalizedRewardsWeek(startWeek: number, endWeek: number): number {
  // Finalized week = last completed week per Thursday 00:00 UTC reporting cadence.
  // We use this to avoid reducing delegatedActive or liquid GLW on weeks whose
  // rewards have not finalized yet.
  const finalizedWeek = getWeekRange().endWeek;
  if (!Number.isFinite(finalizedWeek)) return endWeek;
  if (finalizedWeek < startWeek) return startWeek - 1;
  return Math.min(endWeek, finalizedWeek);
}

interface FarmDistributionTimelinePoint {
  week: number;
  cumulativeDistributedGlwWei: bigint;
}

function buildFarmCumulativeDistributedTimeline(params: {
  rows: ControlApiFarmRewardsHistoryRewardRow[];
}): FarmDistributionTimelinePoint[] {
  const glwRows = params.rows
    .filter((r) => (r.paymentCurrency || "").toUpperCase() === "GLW")
    .map((r) => ({
      week: Math.trunc(r.weekNumber),
      distributed: safeBigInt(r.protocolDepositRewardsDistributed),
    }))
    .filter((r) => Number.isFinite(r.week) && r.week >= 0)
    .sort((a, b) => a.week - b.week);

  const timeline: FarmDistributionTimelinePoint[] = [];
  let cumulative = BigInt(0);
  for (const r of glwRows) {
    if (r.distributed <= BigInt(0)) continue;
    cumulative += r.distributed;
    timeline.push({ week: r.week, cumulativeDistributedGlwWei: cumulative });
  }
  return timeline;
}

interface SegmentState {
  segments: Array<{ startWeek: number; endWeek: number; splitScaled6: bigint }>;
  idx: number;
}

function makeSegmentState(
  segments: ControlApiDepositSplitHistorySegment[]
): SegmentState {
  const parsed = segments
    .map((s) => ({
      startWeek: Math.trunc(s.startWeek),
      endWeek: Math.trunc(s.endWeek),
      splitScaled6: safeBigInt(s.depositSplitPercent6Decimals),
    }))
    .filter(
      (s) =>
        Number.isFinite(s.startWeek) &&
        Number.isFinite(s.endWeek) &&
        s.endWeek >= s.startWeek
    )
    .sort((a, b) => a.startWeek - b.startWeek);
  return { segments: parsed, idx: 0 };
}

function getSplitScaled6AtWeek(state: SegmentState, week: number): bigint {
  const segs = state.segments;
  while (state.idx < segs.length && segs[state.idx]!.endWeek < week)
    state.idx++;
  const seg = segs[state.idx];
  if (!seg) return BigInt(0);
  return seg.startWeek <= week && week <= seg.endWeek
    ? seg.splitScaled6
    : BigInt(0);
}

interface TimelineState {
  timeline: FarmDistributionTimelinePoint[];
  idx: number;
  last: bigint;
}

function makeTimelineState(
  timeline: FarmDistributionTimelinePoint[]
): TimelineState {
  return { timeline, idx: 0, last: BigInt(0) };
}

function getCumulativeDistributedGlwWeiAtWeek(
  state: TimelineState,
  week: number
): bigint {
  while (
    state.idx < state.timeline.length &&
    state.timeline[state.idx]!.week <= week
  ) {
    state.last = state.timeline[state.idx]!.cumulativeDistributedGlwWei;
    state.idx++;
  }
  return state.last;
}

export interface GlowWorthResult {
  walletAddress: string;
  liquidGlwWei: string;
  delegatedActiveGlwWei: string;
  pendingRecoveredGlwWei: string;
  unclaimedGlwRewardsWei: string;
  glowWorthWei: string;
  dataSources: {
    liquidGlw: "onchain";
    delegatedActiveGlw: "db+control-api";
    pendingRecoveredGlw: "control-api";
    unclaimedGlwRewards: "claims-api+control-api";
  };
}

export interface WeeklyImpactRow {
  weekNumber: number;

  // GLW amounts (wei)
  inflationGlwWei: string;
  steeringGlwWei: string;
  delegatedActiveGlwWei: string;
  protocolDepositRecoveredGlwWei: string;
  liquidGlwWei: string; // Historical liquid balance (end-of-week snapshot)
  unclaimedGlwWei: string; // Historical unclaimed rewards

  // Points (scaled6 strings)
  inflationPoints: string;
  steeringPoints: string;
  vaultBonusPoints: string;
  rolloverPointsPreMultiplier: string;
  rolloverMultiplier: number;
  rolloverPoints: string;
  glowWorthGlwWei: string;
  continuousPoints: string;
  totalPoints: string;

  hasCashMinerBonus: boolean;
  baseMultiplier: number;
  streakBonusMultiplier: number;
  impactStreakWeeks: number;
  pointsPerRegion: Record<string, string>;
}

export interface ImpactScoreComposition {
  steeringPoints: string;
  inflationPoints: string;
  worthPoints: string;
  vaultPoints: string;
  referralPoints?: string;
  referralBonusPoints?: string;
}

export interface RegionBreakdown {
  regionId: number;
  directPoints: string;
  glowWorthPoints: string;
}

export interface WeeklyRegionBreakdown {
  weekNumber: number;
  regionId: number;
  inflationPoints: string;
  steeringPoints: string;
  vaultBonusPoints: string;
  glowWorthPoints: string;
  directPoints: string; // total of first 3
}

export interface CurrentWeekProjection {
  weekNumber: number;
  hasMinerMultiplier: boolean;
  hasSteeringStake: boolean;
  impactStreakWeeks: number;
  streakAsOfPreviousWeek: number;
  hasImpactActionThisWeek: boolean;
  baseMultiplier: number;
  streakBonusMultiplier: number;
  totalMultiplier: number;
  projectedPoints: {
    steeringGlwWei: string;
    inflationGlwWei: string;
    delegatedGlwWei: string;
    glowWorthWei: string;
    basePointsPreMultiplierScaled6: string;
    totalProjectedScore: string;
  };
}

export interface GlowImpactScoreResult {
  walletAddress: string;
  weekRange: { startWeek: number; endWeek: number };
  glowWorth: GlowWorthResult;
  warnings?: {
    steering?: string;
  };
  pointsPerRegion?: Record<string, string>;
  regionBreakdown?: RegionBreakdown[];
  weeklyRegionBreakdown?: WeeklyRegionBreakdown[];
  referral?: {
    asReferrer?: {
      totalPointsEarnedScaled6: string;
      thisWeekPointsScaled6: string;
      activeRefereeCount: number;
      pendingRefereeCount: number;
      currentTier: {
        name: "Seed" | "Grow" | "Scale" | "Legend";
        percent: number;
      };
      nextTier?: {
        name: string;
        referralsNeeded: number;
        percent: number;
      };
    };
    asReferee?: {
      referrerWallet: string;
      referrerEns?: string;
      bonusIsActive: boolean;
      bonusEndsAt?: string;
      bonusWeeksRemaining?: number;
      bonusPointsThisWeekScaled6: string;
      bonusPointsProjectedScaled6?: string;
      lifetimeBonusPointsScaled6: string;
      activationBonus: {
        awarded: boolean;
        awardedAt?: string;
        pending?: boolean;
        pointsAwarded: number;
      };
    };
  };
  totals: {
    totalPoints: string;
    rolloverPoints: string;
    continuousPoints: string;
    inflationPoints: string;
    steeringPoints: string;
    vaultBonusPoints: string;
    worthPoints: string;
    basePointsPreMultiplierScaled6: string;
    basePointsPreMultiplierScaled6ThisWeek: string;
    totalInflationGlwWei: string;
    totalSteeringGlwWei: string;
  };
  composition: ImpactScoreComposition;
  lastWeekPoints: string;
  activeMultiplier: boolean;
  hasMinerMultiplier: boolean;
  endWeekMultiplier: number;
  weekly: WeeklyImpactRow[];
}

function getSteeringFallback(params: {
  startWeek: number;
  endWeek: number;
  error: unknown;
}): SteeringByWeekResult {
  const { startWeek, endWeek, error } = params;
  const byWeek = new Map<number, bigint>();
  for (let w = startWeek; w <= endWeek; w++) byWeek.set(w, BigInt(0));
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : JSON.stringify(error);
  return {
    byWeek,
    dataSource: "control-api",
    isFallback: true,
    error: message,
  };
}

function computeSteeringByWeekFromStakeAndRewards(params: {
  walletStakeByWeek: WalletStakeByWeek;
  startWeek: number;
  endWeek: number;
  regionRewardsByEpoch: Map<number, RegionRewardsResponse>;
}): SteeringByWeekResult {
  const byWeek = new Map<number, bigint>();
  const byWeekAndRegion = new Map<number, Map<number, bigint>>();

  for (let week = params.startWeek; week <= params.endWeek; week++) {
    const rewards = params.regionRewardsByEpoch.get(week);
    if (!rewards) continue;

    const rewardsByRegion = new Map<
      number,
      { gctlStaked: bigint; glwRewardWei: bigint }
    >();
    for (const row of rewards.regionRewards || []) {
      rewardsByRegion.set(row.regionId, {
        gctlStaked: safeBigInt(row.gctlStaked),
        glwRewardWei: safeBigInt(row.glwReward),
      });
    }

    const stakeRows = params.walletStakeByWeek.get(week) || [];
    const regionSteering = new Map<number, bigint>();
    let steeringTotal = 0n;
    for (const row of stakeRows) {
      if (row.totalStakedWei <= 0n) continue;
      const regionReward = rewardsByRegion.get(row.regionId);
      if (!regionReward || regionReward.gctlStaked <= 0n) continue;
      const regionSteered =
        (regionReward.glwRewardWei * row.totalStakedWei) / regionReward.gctlStaked;
      steeringTotal += regionSteered;
      regionSteering.set(row.regionId, regionSteered);
    }

    byWeek.set(week, steeringTotal);
    byWeekAndRegion.set(week, regionSteering);
  }

  return { byWeek, byWeekAndRegion, dataSource: "control-api" };
}

async function precomputeSteeringByWalletFromDb(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
  regionRewardsByEpoch: Map<number, RegionRewardsResponse>;
  debug?: ImpactTimingCollector;
}): Promise<{
  steeringByWallet: Map<string, SteeringByWeekResult>;
  missingWallets: Set<string>;
}> {
  const loadStart = nowMs();
  const dbStakeByWallet = await loadWalletStakeByEpochFromDbMany({
    wallets: params.wallets,
    startWeek: params.startWeek,
    endWeek: params.endWeek,
  }).catch((error) => {
    console.error("[impact-score] failed to bulk-load wallet stakes from DB", error);
    return {
      byWallet: new Map<string, WalletStakeByWeek>(),
      coveredWallets: new Set<string>(),
      missingWallets: params.wallets.map((w) => w.toLowerCase()),
    };
  });

  const steeringByWallet = new Map<string, SteeringByWeekResult>();
  for (const wallet of dbStakeByWallet.coveredWallets) {
    const walletStakeByWeek = dbStakeByWallet.byWallet.get(wallet) || new Map();
    const steering = computeSteeringByWeekFromStakeAndRewards({
      walletStakeByWeek,
      startWeek: params.startWeek,
      endWeek: params.endWeek,
      regionRewardsByEpoch: params.regionRewardsByEpoch,
    });
    steeringByWallet.set(wallet, steering);
  }

  recordTimingSafe(params.debug, {
    label: "compute.walletInputs.steeringDbBulk",
    ms: nowMs() - loadStart,
    meta: {
      wallets: params.wallets.length,
      dbCoveredWallets: dbStakeByWallet.coveredWallets.size,
      fallbackWallets: dbStakeByWallet.missingWallets.length,
    },
  });

  return {
    steeringByWallet,
    missingWallets: new Set(dbStakeByWallet.missingWallets),
  };
}

export async function getAllImpactWallets(): Promise<string[]> {
  const wallets = new Set<string>();

  const buyers = await db
    .select({ wallet: fractionSplits.buyer })
    .from(fractionSplits);
  for (const row of buyers) wallets.add(row.wallet.toLowerCase());

  const splitWallets = await db
    .select({
      wallet: RewardSplits.walletAddress,
    })
    .from(RewardSplits);
  for (const row of splitWallets) wallets.add(row.wallet.toLowerCase());

  return Array.from(wallets);
}

export async function getAllDelegatorWallets(): Promise<string[]> {
  const wallets = new Set<string>();

  const buyers = await db
    .select({ wallet: fractionSplits.buyer })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(eq(fractions.type, "launchpad"));

  for (const row of buyers) wallets.add(row.wallet.toLowerCase());

  // Note: With the vault/deposit-split system, a wallet can receive/hold split ownership
  // without directly purchasing launchpad fractions. `RewardSplits` is our DB-side source
  // of wallets with split allocations (also used by `getAllImpactWallets`).
  const splitWallets = await db
    .select({
      wallet: RewardSplits.walletAddress,
    })
    .from(RewardSplits);
  for (const row of splitWallets) wallets.add(row.wallet.toLowerCase());
  return Array.from(wallets);
}

async function getDbDrivenGctlWalletUniverse(): Promise<{
  wallets: string[];
  source: "db" | "control-api";
}> {
  try {
    const stakerWallets = new Set<string>();
    const maxWeekRow = await db
      .select({
        maxWeek: sql<number>`max(${controlWalletStakeByEpoch.weekNumber})`,
      })
      .from(controlWalletStakeByEpoch);
    const latestStakeWeek = Number(maxWeekRow[0]?.maxWeek ?? -1);

    if (Number.isFinite(latestStakeWeek) && latestStakeWeek >= 0) {
      const stakeRows = await db
        .select({ wallet: controlWalletStakeByEpoch.wallet })
        .from(controlWalletStakeByEpoch)
        .where(
          and(
            eq(controlWalletStakeByEpoch.weekNumber, latestStakeWeek),
            sql`${controlWalletStakeByEpoch.regionId} > 0`,
            sql`${controlWalletStakeByEpoch.totalStakedRaw} > 0::numeric`
          )
        );
      for (const row of stakeRows) {
        const wallet = (row.wallet || "").toLowerCase();
        if (!wallet) continue;
        stakerWallets.add(wallet);
      }
    }

    if (stakerWallets.size > 0) {
      return { wallets: Array.from(stakerWallets), source: "db" };
    }

    const mintedWallets = new Set<string>();
    const mintRows = await db
      .select({ wallet: gctlMintEvents.wallet })
      .from(gctlMintEvents)
      .where(sql`${gctlMintEvents.gctlMintedRaw} > 0::numeric`);
    for (const row of mintRows) {
      const wallet = (row.wallet || "").toLowerCase();
      if (!wallet) continue;
      mintedWallets.add(wallet);
    }

    if (mintedWallets.size > 0) {
      return { wallets: Array.from(mintedWallets), source: "db" };
    }
  } catch (error) {
    console.error("[impact-score] failed to load GCTL wallet universe from DB", error);
  }

  const controlApi = await fetchGctlStakersFromControlApi();
  return {
    wallets: controlApi.stakers.map((w) => w.toLowerCase()),
    source: "control-api",
  };
}

export async function getImpactLeaderboardWalletUniverse(params: {
  limit: number;
  debug?: ImpactTimingCollector;
}): Promise<{
  eligibleWallets: string[];
  candidateWallets: string[];
  gctlStakers: string[];
}> {
  const limit = Math.max(params.limit, 1);

  const { debug } = params;
  const [protocolWallets, glwHolders, gctlWalletUniverse] = await Promise.all([
    timePromise(debug, "universe.protocolWallets", getAllImpactWallets()),
    timePromise(debug, "universe.glwHolders", fetchGlwHoldersFromPonder()),
    timePromise(debug, "universe.gctlStakers", getDbDrivenGctlWalletUniverse()),
  ]);

  const gctlStakerWallets = gctlWalletUniverse.wallets.map((w) => w.toLowerCase());

  const eligibleSet = new Set<string>();
  for (const w of protocolWallets) eligibleSet.add(w.toLowerCase());
  for (const w of glwHolders.holders) eligibleSet.add(w.toLowerCase());
  for (const w of gctlStakerWallets) eligibleSet.add(w);

  const poolSize = Math.max(limit * 3, 600);
  const topHolders = glwHolders.topHoldersByBalance.slice(0, poolSize);

  const candidateSet = new Set<string>();
  for (const w of protocolWallets) candidateSet.add(w.toLowerCase());
  for (const w of gctlStakerWallets) candidateSet.add(w);
  for (const w of topHolders) candidateSet.add(w.toLowerCase());

  recordTimingSafe(debug, {
    label: "universe.summary",
    ms: 0,
    meta: {
      limit,
      poolSize,
      eligibleWallets: eligibleSet.size,
      candidateWallets: candidateSet.size,
      protocolWallets: protocolWallets.length,
      glwHolders: glwHolders.holders.length,
      gctlStakers: gctlStakerWallets.length,
      gctlStakersSource: gctlWalletUniverse.source,
    },
  });

  return {
    eligibleWallets: Array.from(eligibleSet),
    candidateWallets: Array.from(candidateSet),
    gctlStakers: gctlStakerWallets,
  };
}

export interface DelegatorsLeaderboardRow {
  rank: number;
  walletAddress: string;
  activelyDelegatedGlwWei: string;
  glwPerWeekWei: string;
  netRewardsWei: string;
  sharePercent: string; // percent as string, e.g. "13.0"
}

export async function computeDelegatorsLeaderboard(params: {
  startWeek: number;
  endWeek: number;
  limit: number;
  excludeWallets?: Set<string>;
  debug?: ImpactTimingCollector;
}): Promise<{
  totalWalletCount: number;
  wallets: DelegatorsLeaderboardRow[];
}> {
  const overallStart = nowMs();
  const { debug } = params;

  const startWeek = Math.max(0, Math.trunc(params.startWeek));
  const endWeek = Math.max(startWeek, Math.trunc(params.endWeek));
  const limit = Math.max(1, Math.trunc(params.limit));
  const excludeWallets = params.excludeWallets;
  const finalizedWeek = getFinalizedRewardsWeek(startWeek, endWeek);

  const universeStart = nowMs();
  let wallets = await getAllDelegatorWallets();
  if (excludeWallets) wallets = wallets.filter((w) => !excludeWallets.has(w));
  recordTimingSafe(debug, {
    label: "delegators.universe",
    ms: nowMs() - universeStart,
    meta: { wallets: wallets.length },
  });

  if (wallets.length === 0)
    return {
      totalWalletCount: 0,
      wallets: [],
    };

  // 1) Rewards history for delegator rewards (inflation + PD received) by wallet/week.
  const walletRewardsMap = new Map<string, ControlApiFarmReward[]>();
  const rewardsStart = nowMs();
  let walletRewardsBatches = 0;
  for (const batch of chunkArray(wallets, BATCH_SIZE)) {
    const batchStart = nowMs();
    const m = await fetchWalletRewardsHistoryBatch({
      wallets: batch,
      startWeek,
      endWeek,
    });
    walletRewardsBatches++;
    recordTimingSafe(debug, {
      label: "delegators.walletRewards.batch",
      ms: nowMs() - batchStart,
      meta: { batchSize: batch.length, startWeek, endWeek },
    });
    for (const [wallet, rewards] of m) walletRewardsMap.set(wallet, rewards);
  }
  recordTimingSafe(debug, {
    label: "delegators.walletRewards.total",
    ms: nowMs() - rewardsStart,
    meta: { wallets: wallets.length, batches: walletRewardsBatches },
  });

  // Find the actual maximum week in the rewards data (may be < endWeek if Control API data isn't finalized yet).
  // This is used for glwPerWeekWei calculation to avoid always returning 0 when endWeek has no data yet.
  let actualMaxWeekInRewards = -1;
  for (const rewards of walletRewardsMap.values()) {
    for (const r of rewards) {
      const week = Number(r.weekNumber);
      if (Number.isFinite(week) && week >= startWeek && week <= endWeek) {
        actualMaxWeekInRewards = Math.max(actualMaxWeekInRewards, week);
      }
    }
  }
  // Fallback to endWeek if no rewards found (e.g. all wallets have no rewards yet).
  const glwPerWeekTargetWeek =
    actualMaxWeekInRewards >= startWeek ? actualMaxWeekInRewards : endWeek;

  recordTimingSafe(debug, {
    label: "delegators.actualMaxWeekInRewards",
    ms: 0,
    meta: {
      endWeek,
      actualMaxWeekInRewards,
      glwPerWeekTargetWeek,
      finalizedWeek,
    },
  });

  // 2) Vault model inputs: deposit split history + farm principal + farm cumulative distributions.
  const depositSplitHistoryByWallet = new Map<
    string,
    ControlApiDepositSplitHistorySegment[]
  >();
  const depositSplitsStart = nowMs();
  let depositSplitBatches = 0;
  for (const batch of chunkArray(wallets, 1000)) {
    const batchStart = nowMs();
    const m = await fetchDepositSplitsHistoryBatch({
      wallets: batch,
      startWeek: DELEGATION_START_WEEK,
      endWeek,
    });
    depositSplitBatches++;
    recordTimingSafe(debug, {
      label: "delegators.depositSplits.batch",
      ms: nowMs() - batchStart,
      meta: {
        batchSize: batch.length,
        startWeek: DELEGATION_START_WEEK,
        endWeek,
      },
    });
    for (const [wallet, segs] of m)
      depositSplitHistoryByWallet.set(wallet, segs);
  }
  recordTimingSafe(debug, {
    label: "delegators.depositSplits.total",
    ms: nowMs() - depositSplitsStart,
    meta: { wallets: wallets.length, batches: depositSplitBatches },
  });

  const farmIdsSet = new Set<string>();
  for (const segs of depositSplitHistoryByWallet.values()) {
    for (const s of segs) farmIdsSet.add(s.farmId);
  }
  const farmIds = Array.from(farmIdsSet);

  const principalByFarm = new Map<string, bigint>();
  if (farmIds.length > 0) {
    const principalStart = nowMs();
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
    recordTimingSafe(debug, {
      label: "delegators.db.principalRows",
      ms: nowMs() - principalStart,
      meta: { rows: principalRows.length, farms: farmIds.length },
    });
    for (const row of principalRows) {
      if (!row.farmId) continue;
      const amountWei = safeBigInt(row.paymentAmount);
      if (amountWei <= 0n) continue;
      principalByFarm.set(
        row.farmId,
        (principalByFarm.get(row.farmId) || 0n) + amountWei
      );
    }
  }

  const glwPrincipalFarmIds = farmIds.filter((id) => {
    const p = principalByFarm.get(id) || 0n;
    return p > 0n;
  });
  const farmRewardsTimelineEndWeek = Math.min(endWeek, finalizedWeek);

  const farmDistributedTimelineByFarm = new Map<
    string,
    FarmDistributionTimelinePoint[]
  >();
  const farmRewardsStart = nowMs();
  let farmRewardsBatches = 0;
  if (farmRewardsTimelineEndWeek >= DELEGATION_START_WEEK) {
    await mapChunksWithConcurrency({
      items: glwPrincipalFarmIds,
      chunkSize: FARM_REWARDS_BATCH_SIZE,
      concurrency: FARM_REWARDS_BATCH_CONCURRENCY,
      worker: async (farmIdBatch) => {
        const batchStart = nowMs();
        const m = await fetchFarmRewardsHistoryBatch({
          farmIds: farmIdBatch,
          startWeek: DELEGATION_START_WEEK,
          endWeek: farmRewardsTimelineEndWeek,
        });
        farmRewardsBatches++;
        recordTimingSafe(debug, {
          label: "delegators.farmRewards.batch",
          ms: nowMs() - batchStart,
          meta: {
            batchSize: farmIdBatch.length,
            startWeek: DELEGATION_START_WEEK,
            endWeek: farmRewardsTimelineEndWeek,
          },
        });
        for (const [farmId, rows] of m) {
          farmDistributedTimelineByFarm.set(
            farmId,
            buildFarmCumulativeDistributedTimeline({ rows })
          );
        }
      },
    });
  }
  recordTimingSafe(debug, {
    label: "delegators.farmRewards.total",
    ms: nowMs() - farmRewardsStart,
    meta: {
      farms: glwPrincipalFarmIds.length,
      batches: farmRewardsBatches,
      timelineEndWeek: farmRewardsTimelineEndWeek,
    },
  });

  // 3) Compute leaderboard rows.
  const computeStart = nowMs();
  const computedRows: Array<{
    walletAddress: string;
    activelyDelegatedGlwWei: bigint;
    glwPerWeekWei: bigint;
    grossRewardsWei: bigint;
    netRewardsWei: bigint;
  }> = [];

  for (const wallet of wallets) {
    const splitSegments = depositSplitHistoryByWallet.get(wallet) || [];
    if (splitSegments.length === 0) continue;

    const splitSegmentsByFarm = new Map<
      string,
      ControlApiDepositSplitHistorySegment[]
    >();
    for (const seg of splitSegments) {
      const principalWei = principalByFarm.get(seg.farmId) || 0n;
      if (principalWei <= 0n) continue;
      if (!splitSegmentsByFarm.has(seg.farmId))
        splitSegmentsByFarm.set(seg.farmId, []);
      splitSegmentsByFarm.get(seg.farmId)!.push(seg);
    }

    const farmStates = new Map<
      string,
      {
        splitSegments: ControlApiDepositSplitHistorySegment[];
        principalWei: bigint;
        distributedTimeline: FarmDistributionTimelinePoint[];
      }
    >();
    for (const [farmId, segs] of splitSegmentsByFarm) {
      const principalWei = principalByFarm.get(farmId) || 0n;
      if (principalWei <= 0n) continue;
      const timeline = farmDistributedTimelineByFarm.get(farmId) || [];
      farmStates.set(farmId, {
        splitSegments: segs,
        principalWei,
        distributedTimeline: timeline,
      });
    }

    if (farmStates.size === 0) continue;

    let activelyDelegatedGlwWei = 0n;
    for (const [, farm] of farmStates) {
      // IMPORTANT: `SegmentState` and `TimelineState` are cursor-based (mutable).
      // Never reuse the same state object across different traversal orders.
      const splitState = makeSegmentState(farm.splitSegments);
      const distState = makeTimelineState(farm.distributedTimeline);

      const splitScaled6 = getSplitScaled6AtWeek(splitState, endWeek);
      if (splitScaled6 <= 0n) continue;
      // Use last finalized week for recovery when the requested week isn't finalized yet.
      const recoveryWeek = endWeek <= finalizedWeek ? endWeek : finalizedWeek;
      const cumulativeDistributed = getCumulativeDistributedGlwWeiAtWeek(
        distState,
        recoveryWeek
      );
      const remaining = clampToZero(farm.principalWei - cumulativeDistributed);
      activelyDelegatedGlwWei +=
        (remaining * splitScaled6) / SPLIT_SCALE_SCALED6;
    }

    let principalAllocatedWei = 0n;
    for (const [, farm] of farmStates) {
      // Fresh cursor states for monotonic week traversal.
      const splitState = makeSegmentState(farm.splitSegments);
      const distState = makeTimelineState(farm.distributedTimeline);
      // Seed the "previous week" cumulative so the first delta is scoped to `startWeek`,
      // not the entire farm history prior to `startWeek`.
      // Seed recovery at the latest finalized week if we're still ahead of reports.
      const recoverySeedWeek =
        finalizedWeek < startWeek ? finalizedWeek : startWeek - 1;
      let prevCumulativeDistributed =
        startWeek > 0
          ? getCumulativeDistributedGlwWeiAtWeek(distState, recoverySeedWeek)
          : 0n;

      for (let week = startWeek; week <= endWeek; week++) {
        // Clamp recovery to the finalized week so unfinalized weeks don't reduce principal.
        const recoveryWeek = week <= finalizedWeek ? week : finalizedWeek;
        const cumulative = getCumulativeDistributedGlwWeiAtWeek(
          distState,
          recoveryWeek
        );
        const delta = cumulative - prevCumulativeDistributed;
        // Always advance `prevCumulativeDistributed`, even if we end up skipping this
        // week due to `splitScaled6 <= 0`. Otherwise, farm distributions from skipped
        // weeks would be incorrectly attributed to later weeks where the split is > 0.
        prevCumulativeDistributed = cumulative;
        if (delta <= 0n) continue;

        const splitScaled6 = getSplitScaled6AtWeek(splitState, week);
        if (splitScaled6 <= 0n) continue;
        principalAllocatedWei += (delta * splitScaled6) / SPLIT_SCALE_SCALED6;
      }
    }

    const rewards = walletRewardsMap.get(wallet) || [];
    let grossRewardsWei = 0n;
    let glwPerWeekWei = 0n; // most recent week with finalized rewards (glwPerWeekTargetWeek)

    for (const r of rewards) {
      const week = Number(r.weekNumber);
      if (!Number.isFinite(week)) continue;
      if (week < startWeek || week > endWeek) continue;

      const inflationLaunchpad = safeBigInt(r.walletInflationFromLaunchpad);
      const pdRaw = safeBigInt(r.walletProtocolDepositFromLaunchpad);
      const pdGlw = protocolDepositReceivedGlwWei({
        amountRaw: pdRaw,
        asset: r.asset,
      });

      const grossThisWeek = inflationLaunchpad + pdGlw;
      grossRewardsWei += grossThisWeek;
      // Use the most recent week that actually has rewards data (Control API finalization lag).
      if (week === glwPerWeekTargetWeek) {
        glwPerWeekWei += grossThisWeek;
      }
    }

    const netRewardsWei = clampToZero(grossRewardsWei - principalAllocatedWei);

    if (
      activelyDelegatedGlwWei <= 0n &&
      grossRewardsWei <= 0n &&
      netRewardsWei <= 0n
    ) {
      continue;
    }

    computedRows.push({
      walletAddress: wallet,
      activelyDelegatedGlwWei,
      glwPerWeekWei,
      grossRewardsWei,
      netRewardsWei,
    });
  }

  recordTimingSafe(debug, {
    label: "delegators.compute.rows",
    ms: nowMs() - computeStart,
    meta: { wallets: wallets.length, rows: computedRows.length },
  });

  let totalGrossRewardsWei = 0n;
  for (const r of computedRows) totalGrossRewardsWei += r.grossRewardsWei;

  computedRows.sort((a, b) => {
    const netDiff = b.netRewardsWei - a.netRewardsWei;
    if (netDiff !== 0n) return netDiff > 0n ? 1 : -1;
    const grossDiff = b.grossRewardsWei - a.grossRewardsWei;
    if (grossDiff !== 0n) return grossDiff > 0n ? 1 : -1;
    return a.walletAddress.localeCompare(b.walletAddress);
  });

  const sliced = computedRows.slice(0, limit);
  const walletsOut: DelegatorsLeaderboardRow[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const r = sliced[i]!;
    const shareTenths =
      totalGrossRewardsWei > 0n
        ? (r.grossRewardsWei * 1000n) / totalGrossRewardsWei
        : 0n;
    const sharePercent = `${shareTenths / 10n}.${shareTenths % 10n}`;

    walletsOut.push({
      rank: i + 1,
      walletAddress: r.walletAddress,
      activelyDelegatedGlwWei: r.activelyDelegatedGlwWei.toString(),
      glwPerWeekWei: r.glwPerWeekWei.toString(),
      netRewardsWei: r.netRewardsWei.toString(),
      sharePercent,
    });
  }

  recordTimingSafe(debug, {
    label: "delegators.total",
    ms: nowMs() - overallStart,
    meta: {
      totalWalletCount: computedRows.length,
      returned: walletsOut.length,
      startWeek,
      endWeek,
    },
  });

  return {
    totalWalletCount: computedRows.length,
    wallets: walletsOut,
  };
}

function toPseudoWalletRewardsRowsFromWeekly(
  rows: ControlApiWalletWeeklyRewardRow[]
): ControlApiFarmReward[] {
  return rows.map((row) => ({
    weekNumber: row.weekNumber,
    farmId: "",
    asset: row.paymentCurrency ?? "GLW",
    walletTotalGlowInflationReward: row.glowInflationTotal ?? "0",
    walletProtocolDepositFromLaunchpad:
      row.protocolDepositRewardsReceived ?? "0",
  }));
}

async function loadWalletRewardsForGlowWorth(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiFarmReward[]>> {
  const { wallets, startWeek, endWeek } = params;
  if (wallets.length === 1) {
    const wallet = wallets[0]!;
    try {
      const weeklyRows = await fetchWalletWeeklyRewards({
        walletAddress: wallet,
        paymentCurrency: "GLW",
        limit: 520,
        startWeek,
        endWeek,
      });
      return new Map([
        [wallet, toPseudoWalletRewardsRowsFromWeekly(weeklyRows)],
      ]);
    } catch (error) {
      console.warn(
        `[impact-score] wallet weekly rewards fast-path failed for wallet=${wallet}; falling back to batch endpoint`,
        error
      );
    }
  }

  return await fetchWalletRewardsHistoryBatch({
    wallets,
    startWeek,
    endWeek,
  });
}

export async function computeGlowWorths(params: {
  walletAddresses: string[];
  startWeek: number;
  endWeek: number;
  debug?: ImpactTimingCollector;
}): Promise<GlowWorthResult[]> {
  const { walletAddresses, startWeek, endWeek, debug } = params;
  const overallStart = nowMs();
  const finalizedWeek = getFinalizedRewardsWeek(startWeek, endWeek);

  const wallets = walletAddresses
    .map((w) => w.toLowerCase())
    .filter((w, idx, arr) => arr.indexOf(w) === idx);
  if (wallets.length === 0) return [];

  const rewardsFetchStartWeek = Math.min(startWeek, DELEGATION_START_WEEK);
  const nowSec = Math.floor(Date.now() / 1000);
  const currentEpoch = getCurrentEpoch(nowSec);
  const claimableThresholdWeek = Math.min(currentEpoch - 3, currentEpoch - 4);
  const claimableEndWeek = Math.min(endWeek, claimableThresholdWeek);
  const claimableStartWeek = startWeek;
  const claimableStartWeekForFetch = DELEGATION_START_WEEK;

  const glwToken = addresses.glow.toLowerCase();
  const hexWallets = wallets.filter(isHexWallet) as Array<`0x${string}`>;

  const parallelFetchStart = nowMs();
  const walletRewardsPromise = loadWalletRewardsForGlowWorth({
    wallets,
    startWeek: rewardsFetchStartWeek,
    endWeek,
  });
  const depositSplitsPromise = fetchDepositSplitsHistoryBatch({
    wallets,
    startWeek: DELEGATION_START_WEEK,
    endWeek,
  });
  const claimsPromise = fetchClaimsBatch({ wallets });
  const claimedPdWeeksPromise =
    claimableEndWeek >= claimableStartWeekForFetch
      ? fetchClaimedPdWeeksBatch({
          wallets,
          startWeek: claimableStartWeekForFetch,
          endWeek: claimableEndWeek,
        })
      : Promise.resolve(new Map<string, Map<number, number>>());
  const liquidBatchPromise = getLiquidGlwBalancesWeiBatch(hexWallets).catch(
    (error) => {
      console.error(
        `[impact-score] liquid balance batch fetch failed for wallets=${hexWallets.length}; using zero fallback`,
        error
      );
      const zeros = new Map<string, bigint>();
      for (const wallet of hexWallets) zeros.set(wallet.toLowerCase(), 0n);
      return zeros;
    }
  );
  const glwSplitRowsPromise = db
    .select({
      buyer: fractionSplits.buyer,
      amount: fractionSplits.amount,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, wallets),
        eq(fractions.type, "launchpad"),
        or(isNull(fractions.token), eq(sql`lower(${fractions.token})`, glwToken))
      )
    );
  const glwRefundRowsPromise = db
    .select({
      refundTo: fractionRefunds.refundTo,
      amount: fractionRefunds.amount,
    })
    .from(fractionRefunds)
    .innerJoin(fractions, eq(fractionRefunds.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionRefunds.refundTo, wallets),
        eq(fractions.type, "launchpad"),
        or(isNull(fractions.token), eq(sql`lower(${fractions.token})`, glwToken))
      )
    );

  const depositSplitHistoryByWallet = await depositSplitsPromise;
  const farmIdsSet = new Set<string>();
  for (const segs of depositSplitHistoryByWallet.values()) {
    for (const s of segs) farmIdsSet.add(s.farmId);
  }
  const farmIds = Array.from(farmIdsSet);

  const principalByFarm = new Map<string, bigint>();
  if (farmIds.length > 0) {
    const principalStart = nowMs();
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
    recordTimingSafe(debug, {
      label: "glowWorth.db.principalRows",
      ms: nowMs() - principalStart,
      meta: { rows: principalRows.length, farms: farmIds.length },
    });
    for (const row of principalRows) {
      if (!row.farmId) continue;
      const amountWei = safeBigInt(row.paymentAmount);
      if (amountWei <= 0n) continue;
      principalByFarm.set(
        row.farmId,
        (principalByFarm.get(row.farmId) || 0n) + amountWei
      );
    }
  }

  const glwPrincipalFarmIds = farmIds.filter(
    (id) => (principalByFarm.get(id) || 0n) > 0n
  );
  const farmRewardsTimelineEndWeek = Math.min(endWeek, finalizedWeek);
  const farmDistributedTimelineByFarmPromise = (async () => {
    const farmDistributedTimelineByFarm = new Map<
      string,
      FarmDistributionTimelinePoint[]
    >();
    const farmRewardsStart = nowMs();
    let farmRewardsBatches = 0;
    if (
      glwPrincipalFarmIds.length > 0 &&
      farmRewardsTimelineEndWeek >= DELEGATION_START_WEEK
    ) {
      await mapChunksWithConcurrency({
        items: glwPrincipalFarmIds,
        chunkSize: FARM_REWARDS_BATCH_SIZE,
        concurrency: FARM_REWARDS_BATCH_CONCURRENCY,
        worker: async (farmIdBatch) => {
          const batchStart = nowMs();
          const m = await fetchFarmRewardsHistoryBatch({
            farmIds: farmIdBatch,
            startWeek: DELEGATION_START_WEEK,
            endWeek: farmRewardsTimelineEndWeek,
          });
          farmRewardsBatches++;
          recordTimingSafe(debug, {
            label: "glowWorth.farmRewards.batch",
            ms: nowMs() - batchStart,
            meta: {
              batchSize: farmIdBatch.length,
              startWeek: DELEGATION_START_WEEK,
              endWeek: farmRewardsTimelineEndWeek,
            },
          });
          for (const [farmId, rows] of m) {
            farmDistributedTimelineByFarm.set(
              farmId,
              buildFarmCumulativeDistributedTimeline({ rows })
            );
          }
        },
      });
    }
    recordTimingSafe(debug, {
      label: "glowWorth.farmRewards.total",
      ms: nowMs() - farmRewardsStart,
      meta: {
        farms: glwPrincipalFarmIds.length,
        batches: farmRewardsBatches,
        timelineEndWeek: farmRewardsTimelineEndWeek,
      },
    });
    return farmDistributedTimelineByFarm;
  })();

  const [
    walletRewardsMap,
    allClaimsByWallet,
    claimedPdWeeksByWallet,
    liquidByWalletBatch,
    glwSplitRows,
    glwRefundRows,
  ] = await Promise.all([
    walletRewardsPromise,
    claimsPromise,
    claimedPdWeeksPromise,
    liquidBatchPromise,
    glwSplitRowsPromise,
    glwRefundRowsPromise,
  ]);

  recordTimingSafe(debug, {
    label: "glowWorth.parallelFetches",
    ms: nowMs() - parallelFetchStart,
    meta: {
      wallets: wallets.length,
      startWeek,
      endWeek,
      claimableEndWeek,
    },
  });

  const farmDistributedTimelineByFarm = await farmDistributedTimelineByFarmPromise;

  const glwPurchasesByWallet = new Map<string, bigint>();
  for (const row of glwSplitRows) {
    const wallet = row.buyer.toLowerCase();
    const amountWei = safeBigInt(row.amount);
    if (amountWei <= 0n) continue;
    glwPurchasesByWallet.set(wallet, (glwPurchasesByWallet.get(wallet) || 0n) + amountWei);
  }

  const glwRefundsByWallet = new Map<string, bigint>();
  for (const row of glwRefundRows) {
    const wallet = row.refundTo.toLowerCase();
    const amountWei = safeBigInt(row.amount);
    if (amountWei <= 0n) continue;
    glwRefundsByWallet.set(wallet, (glwRefundsByWallet.get(wallet) || 0n) + amountWei);
  }

  const GLW_TOKEN = addresses.glow.toLowerCase();
  const AMOUNT_MATCH_EPSILON_WEI = BigInt(10_000_000);
  const WEEK_97_START_TIMESTAMP = GENESIS_TIMESTAMP + 97 * 604800;

  const results: GlowWorthResult[] = [];
  const computeStart = nowMs();
  for (const wallet of wallets) {
    const rewards = walletRewardsMap.get(wallet) || [];

    const inflationByWeek = new Map<number, bigint>();
    const pdByWeek = new Map<number, bigint>();
    let maxWeek = -1;
    for (const r of rewards) {
      const week = Number(r.weekNumber);
      if (!Number.isFinite(week)) continue;
      maxWeek = week > maxWeek ? week : maxWeek;

      const inflation = safeBigInt(r.walletTotalGlowInflationReward);
      if (inflation > 0n) {
        inflationByWeek.set(week, (inflationByWeek.get(week) || 0n) + inflation);
      }

      const pdRaw = safeBigInt(r.walletProtocolDepositFromLaunchpad);
      const recoveredGlw = protocolDepositReceivedGlwWei({
        amountRaw: pdRaw,
        asset: r.asset,
      });
      if (recoveredGlw > 0n) {
        pdByWeek.set(week, (pdByWeek.get(week) || 0n) + recoveredGlw);
      }
    }

    const claimPdData =
      claimedPdWeeksByWallet.get(wallet) || new Map<number, number>();
    const claims = allClaimsByWallet.get(wallet) || [];
    const claimedInflationWeeks = new Map<number, number>();
    for (const c of claims) {
      const token = String(c?.token || "").toLowerCase();
      if (token !== GLW_TOKEN) continue;
      const timestamp = Number(c?.timestamp);
      if (timestamp < WEEK_97_START_TIMESTAMP) continue;
      const source = String(c?.source || "");
      if (source !== "minerPool") continue;

      const amountWei = safeBigInt(c?.amount);
      let bestWeek: number | null = null;
      let bestDiff: bigint | null = null;
      let secondBestDiff: bigint | null = null;

      for (const [week, amount] of inflationByWeek) {
        if (week < 97) continue;
        const diff =
          amountWei >= amount ? amountWei - amount : amount - amountWei;
        if (bestDiff == null || diff < bestDiff) {
          secondBestDiff = bestDiff;
          bestDiff = diff;
          bestWeek = week;
          continue;
        }
        if (secondBestDiff == null || diff < secondBestDiff) {
          secondBestDiff = diff;
        }
      }

      if (
        bestWeek != null &&
        bestDiff != null &&
        bestDiff <= AMOUNT_MATCH_EPSILON_WEI
      ) {
        if (
          secondBestDiff == null ||
          secondBestDiff > AMOUNT_MATCH_EPSILON_WEI
        ) {
          claimedInflationWeeks.set(bestWeek, timestamp);
        }
      }
    }

    let unclaimedWei = 0n;
    const effectiveEndWeek = Math.min(claimableEndWeek, maxWeek);
    if (effectiveEndWeek >= claimableStartWeek) {
      for (let w = claimableStartWeek; w <= effectiveEndWeek; w++) {
        const inflationWei = inflationByWeek.get(w) || 0n;
        const pdWei = pdByWeek.get(w) || 0n;
        if (inflationWei > 0n && !claimedInflationWeeks.has(w)) {
          unclaimedWei += inflationWei;
        }
        if (pdWei > 0n && !claimPdData.has(w)) {
          unclaimedWei += pdWei;
        }
      }
    }

    const pdCumulativeByWeek = new Map<number, bigint>();
    let pdRunning = 0n;
    for (let w = startWeek; w <= endWeek; w++) {
      pdRunning += pdByWeek.get(w) || 0n;
      pdCumulativeByWeek.set(w, pdRunning);
    }
    const totalPdCumulative = pdCumulativeByWeek.get(endWeek) || 0n;
    let claimablePdCumulative = 0n;
    if (claimableEndWeek >= startWeek) {
      const claimWeek = Math.min(claimableEndWeek, endWeek);
      claimablePdCumulative = pdCumulativeByWeek.get(claimWeek) || 0n;
    }
    const pendingRecoveredCurrentWei =
      totalPdCumulative > claimablePdCumulative
        ? totalPdCumulative - claimablePdCumulative
        : 0n;

    const splitSegments = depositSplitHistoryByWallet.get(wallet) || [];
    const splitSegmentsByFarm = new Map<
      string,
      ControlApiDepositSplitHistorySegment[]
    >();
    for (const seg of splitSegments) {
      const principalWei = principalByFarm.get(seg.farmId) || 0n;
      if (principalWei <= 0n) continue;
      if (!splitSegmentsByFarm.has(seg.farmId)) {
        splitSegmentsByFarm.set(seg.farmId, []);
      }
      splitSegmentsByFarm.get(seg.farmId)!.push(seg);
    }

    let grossShareAtEndWeek = 0n;
    let delegatedActiveNow = 0n;
    for (const [farmId, segs] of splitSegmentsByFarm) {
      const principalWei = principalByFarm.get(farmId) || 0n;
      if (principalWei <= 0n) continue;

      const splitState = makeSegmentState(segs);
      const splitScaled6 = getSplitScaled6AtWeek(splitState, endWeek);
      if (splitScaled6 <= 0n) continue;

      grossShareAtEndWeek +=
        (principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;

      const timeline = farmDistributedTimelineByFarm.get(farmId) || [];
      const distState = makeTimelineState(timeline);
      const recoveryWeek = endWeek <= finalizedWeek ? endWeek : finalizedWeek;
      const cumulativeDistributed = getCumulativeDistributedGlwWeiAtWeek(
        distState,
        recoveryWeek
      );
      const remaining = clampToZero(principalWei - cumulativeDistributed);
      delegatedActiveNow += (remaining * splitScaled6) / SPLIT_SCALE_SCALED6;
    }

    const purchasedGlwWei = glwPurchasesByWallet.get(wallet) || 0n;
    const refundedGlwWei = glwRefundsByWallet.get(wallet) || 0n;
    const netPurchasedGlwWei =
      purchasedGlwWei > refundedGlwWei ? purchasedGlwWei - refundedGlwWei : 0n;
    const pendingDelegatedGlwWei =
      netPurchasedGlwWei > grossShareAtEndWeek
        ? netPurchasedGlwWei - grossShareAtEndWeek
        : 0n;
    const delegatedActiveEffectiveWei =
      delegatedActiveNow + pendingDelegatedGlwWei;

    const liquidGlwWei = isHexWallet(wallet)
      ? liquidByWalletBatch.get(wallet.toLowerCase()) || 0n
      : 0n;
    const glowWorthNowWei =
      liquidGlwWei +
      delegatedActiveEffectiveWei +
      unclaimedWei +
      pendingRecoveredCurrentWei;

    results.push({
      walletAddress: wallet,
      liquidGlwWei: liquidGlwWei.toString(),
      delegatedActiveGlwWei: delegatedActiveEffectiveWei.toString(),
      pendingRecoveredGlwWei: pendingRecoveredCurrentWei.toString(),
      unclaimedGlwRewardsWei: unclaimedWei.toString(),
      glowWorthWei: glowWorthNowWei.toString(),
      dataSources: {
        liquidGlw: "onchain",
        delegatedActiveGlw: "db+control-api",
        pendingRecoveredGlw: "control-api",
        unclaimedGlwRewards: "claims-api+control-api",
      },
    });
  }

  recordTimingSafe(debug, {
    label: "glowWorth.compute",
    ms: nowMs() - computeStart,
    meta: { wallets: wallets.length, startWeek, endWeek },
  });
  recordTimingSafe(debug, {
    label: "glowWorth.total",
    ms: nowMs() - overallStart,
    meta: { wallets: wallets.length, startWeek, endWeek },
  });

  return results;
}

export async function computeGlowImpactScores(params: {
  walletAddresses: string[];
  startWeek: number;
  endWeek: number;
  includeWeeklyBreakdown: boolean;
  includeRegionBreakdown?: boolean;
  includeWeeklyRegionBreakdown?: boolean;
  debug?: ImpactTimingCollector;
}): Promise<GlowImpactScoreResult[]> {
  const {
    walletAddresses,
    startWeek,
    endWeek,
    includeWeeklyBreakdown,
    includeRegionBreakdown = false,
    includeWeeklyRegionBreakdown = false,
    debug,
  } = params;
  const overallStart = nowMs();
  const finalizedWeek = getFinalizedRewardsWeek(startWeek, endWeek);
  const steeringComputationEndWeek = Math.min(endWeek, finalizedWeek);
  const hasSteeringRange = steeringComputationEndWeek >= startWeek;

  const wallets = walletAddresses
    .map((w) => w.toLowerCase())
    .filter((w, idx, arr) => arr.indexOf(w) === idx);

  const farmStatesByWallet = new Map<
    string,
    Map<
      string,
      {
        split: SegmentState;
        principalWei: bigint;
        dist: TimelineState;
        regionId: number;
      }
    >
  >();

  if (wallets.length === 0) return [];
  const isSingleWalletQuery = wallets.length === 1;

  // Note: We intentionally do NOT convert non-GLW protocol deposit payouts to GLW
  // for `delegatedActiveGlwWei`. Only GLW-denominated protocol-deposit payouts count.

  // Prepare parameters for parallel fetches
  const rewardsFetchStartWeek = Math.min(startWeek, DELEGATION_START_WEEK);
  const streakSeedStartWeek = Math.max(startWeek - STREAK_BONUS_CAP_WEEKS, 0);
  const miningStartTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const miningEndTimestamp = GENESIS_TIMESTAMP + (endWeek + 1) * 604800 - 1;

  // Run independent fetches in parallel
  const parallelFetchStart = nowMs();
  const glwToken = addresses.glow.toLowerCase();
  const liquidSnapshotPromise = fetchGlwBalanceSnapshotByWeekMany({
    wallets,
    startWeek,
    endWeek,
  }).catch((error) => {
    console.error(
      `[impact-score] Balance snapshot fetch failed (wallets=${wallets.length}, startWeek=${startWeek}, endWeek=${endWeek})`,
      error
    );
    return new Map<
      string,
      Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>
    >();
  });
  const walletRewardsPromise = fetchWalletRewardsHistoryBatch({
    wallets,
    startWeek: rewardsFetchStartWeek,
    endWeek,
  });
  const miningRowsPromise = db
    .select({
      buyer: fractionSplits.buyer,
      timestamp: fractionSplits.timestamp,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, wallets),
        eq(fractions.type, "mining-center"),
        gte(fractionSplits.timestamp, miningStartTimestamp),
        lte(fractionSplits.timestamp, miningEndTimestamp)
      )
    );
  const depositSplitsPromise = fetchDepositSplitsHistoryBatch({
    wallets,
    startWeek: DELEGATION_START_WEEK,
    endWeek,
  });
  const glwSplitRowsPromise = db
    .select({
      buyer: fractionSplits.buyer,
      amount: fractionSplits.amount,
      timestamp: fractionSplits.timestamp,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, wallets),
        eq(fractions.type, "launchpad"),
        or(isNull(fractions.token), eq(sql`lower(${fractions.token})`, glwToken))
      )
    );
  const glwRefundRowsPromise = db
    .select({
      refundTo: fractionRefunds.refundTo,
      amount: fractionRefunds.amount,
      timestamp: fractionRefunds.timestamp,
    })
    .from(fractionRefunds)
    .innerJoin(fractions, eq(fractionRefunds.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionRefunds.refundTo, wallets),
        eq(fractions.type, "launchpad"),
        or(isNull(fractions.token), eq(sql`lower(${fractions.token})`, glwToken))
      )
    );

  const depositSplitHistoryByWallet = await depositSplitsPromise;
  const farmIdsSet = new Set<string>();
  for (const segs of depositSplitHistoryByWallet.values()) {
    for (const s of segs) farmIdsSet.add(s.farmId);
  }
  const farmIds = Array.from(farmIdsSet);

  const principalByFarm = new Map<string, bigint>();
  const regionByFarm = new Map<string, number>();
  if (farmIds.length > 0) {
    const principalQueryStart = nowMs();
    const principalRows = await db
      .select({
        farmId: applications.farmId,
        paymentAmount: applications.paymentAmount,
        zoneId: applications.zoneId,
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
    recordTimingSafe(debug, {
      label: "compute.db.principalRows",
      ms: nowMs() - principalQueryStart,
      meta: { rows: principalRows.length, farms: farmIds.length },
    });
    for (const row of principalRows) {
      if (!row.farmId) continue;
      const amountWei = safeBigInt(row.paymentAmount);
      if (amountWei > BigInt(0)) {
        principalByFarm.set(
          row.farmId,
          (principalByFarm.get(row.farmId) || BigInt(0)) + amountWei
        );
      }
      regionByFarm.set(row.farmId, row.zoneId);
    }
  }

  const glwPrincipalFarmIds = farmIds.filter(
    (id) => (principalByFarm.get(id) || BigInt(0)) > BigInt(0)
  );
  const farmRewardsTimelineEndWeek = Math.min(endWeek, finalizedWeek);
  const farmDistributedTimelineByFarmPromise = (async () => {
    const farmDistributedTimelineByFarm = new Map<
      string,
      FarmDistributionTimelinePoint[]
    >();
    const farmRewardsStart = nowMs();
    let farmRewardsBatches = 0;
    if (farmRewardsTimelineEndWeek >= DELEGATION_START_WEEK) {
      await mapChunksWithConcurrency({
        items: glwPrincipalFarmIds,
        chunkSize: FARM_REWARDS_BATCH_SIZE,
        concurrency: FARM_REWARDS_BATCH_CONCURRENCY,
        worker: async (farmIdBatch) => {
          const batchStart = nowMs();
          const m = await fetchFarmRewardsHistoryBatch({
            farmIds: farmIdBatch,
            startWeek: DELEGATION_START_WEEK,
            endWeek: farmRewardsTimelineEndWeek,
          });
          farmRewardsBatches++;
          recordTimingSafe(debug, {
            label: "compute.farmRewards.batch",
            ms: nowMs() - batchStart,
            meta: {
              batchSize: farmIdBatch.length,
              startWeek: DELEGATION_START_WEEK,
              endWeek: farmRewardsTimelineEndWeek,
            },
          });
          for (const [farmId, rows] of m)
            farmDistributedTimelineByFarm.set(
              farmId,
              buildFarmCumulativeDistributedTimeline({ rows })
            );
        },
      });
    }
    recordTimingSafe(debug, {
      label: "compute.farmRewards.total",
      ms: nowMs() - farmRewardsStart,
      meta: {
        farms: glwPrincipalFarmIds.length,
        batches: farmRewardsBatches,
        timelineEndWeek: farmRewardsTimelineEndWeek,
      },
    });
    return farmDistributedTimelineByFarm;
  })();

  const [
    liquidSnapshotByWalletWeek,
    walletRewardsMap,
    miningRows,
    glwSplitRows,
    glwRefundRows,
  ] = await Promise.all([
    liquidSnapshotPromise,
    walletRewardsPromise,
    miningRowsPromise,
    glwSplitRowsPromise,
    glwRefundRowsPromise,
  ]);

  recordTimingSafe(debug, {
    label: "compute.parallelFetches",
    ms: nowMs() - parallelFetchStart,
    meta: { wallets: wallets.length, startWeek, endWeek },
  });

  const miningPurchaseWeeksByWallet = new Map<string, Set<number>>();
  for (const row of miningRows) {
    const wallet = row.buyer.toLowerCase();
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > endWeek) continue;
    if (!miningPurchaseWeeksByWallet.has(wallet))
      miningPurchaseWeeksByWallet.set(wallet, new Set());
    miningPurchaseWeeksByWallet.get(wallet)!.add(week);
  }

  const glwPurchasesByWallet = new Map<string, bigint>();
  const glwNetPurchasesByWalletWeek = new Map<string, Map<number, bigint>>();
  const addNetPurchaseByWeek = (
    wallet: string,
    week: number,
    amountWei: bigint
  ) => {
    if (!Number.isFinite(week)) return;
    if (!glwNetPurchasesByWalletWeek.has(wallet))
      glwNetPurchasesByWalletWeek.set(wallet, new Map());
    const byWeek = glwNetPurchasesByWalletWeek.get(wallet)!;
    byWeek.set(week, (byWeek.get(week) || 0n) + amountWei);
  };
  for (const row of glwSplitRows) {
    const wallet = row.buyer.toLowerCase();
    const amountWei = safeBigInt(row.amount);
    if (amountWei <= 0n) continue;
    glwPurchasesByWallet.set(
      wallet,
      (glwPurchasesByWallet.get(wallet) || 0n) + amountWei
    );
    const week = getCurrentEpoch(row.timestamp);
    addNetPurchaseByWeek(wallet, week, amountWei);
  }

  const glwRefundsByWallet = new Map<string, bigint>();
  for (const row of glwRefundRows) {
    const wallet = row.refundTo.toLowerCase();
    const amountWei = safeBigInt(row.amount);
    if (amountWei <= 0n) continue;
    glwRefundsByWallet.set(
      wallet,
      (glwRefundsByWallet.get(wallet) || 0n) + amountWei
    );
    const week = getCurrentEpoch(row.timestamp);
    addNetPurchaseByWeek(wallet, week, -amountWei);
  }

  // Fetch onchain liquid balances + mock unclaimed rewards and steering (per wallet).
  const liquidByWallet = new Map<string, bigint>();
  const unclaimedByWallet = new Map<
    string,
    { amountWei: bigint; dataSource: "claims-api+control-api" }
  >();
  const steeringByWallet = new Map<string, SteeringByWeekResult>();

  // Reward timelines for historical unclaimed calculation.
  const rewardsTimelineByWallet = new Map<
    string,
    {
      inflation: Map<number, bigint>;
      pd: Map<number, bigint>;
      detailed?: Map<
        number,
        {
          inflation: Array<{ amount: bigint; regionId: number }>;
          pd: Array<{ amount: bigint; regionId: number }>;
        }
      >;
    }
  >();
  const claimedPdWeeksByWalletState = new Map<string, Map<number, number>>();
  const claimedInflationWeeksByWalletState = new Map<
    string,
    Map<number, number>
  >();

  const nowSec = Math.floor(Date.now() / 1000);
  const currentEpoch = getCurrentEpoch(nowSec);
  const claimableThresholdWeek = Math.min(currentEpoch - 3, currentEpoch - 4);
  const claimableEndWeek = Math.min(endWeek, claimableThresholdWeek);
  const claimableStartWeek = startWeek; // For "current unclaimed" snapshot calculation
  // For historical unclaimed calculation, we need ALL claims from the start of v2 (Week 97)
  // not just from the user's startWeek. Otherwise, we miss claims for earlier weeks when
  // calculating historical unclaimed for weeks in the middle of the range.
  const claimableStartWeekForFetch = DELEGATION_START_WEEK;

  // Accurate unclaimed calculation for all wallets.
  // We batch fetch all inputs (rewards, PD claimed weeks, and raw claims for inflation inference).
  const claimsStart = nowMs();
  const [claimedPdWeeksByWallet, allClaimsByWallet] = await Promise.all([
    fetchClaimedPdWeeksBatch({
      wallets,
      startWeek: claimableStartWeekForFetch,
      endWeek: claimableEndWeek,
    }),
    fetchClaimsBatch({
      wallets,
    }),
  ]);
  recordTimingSafe(debug, {
    label: "compute.claims.batch",
    ms: nowMs() - claimsStart,
    meta: {
      wallets: wallets.length,
      startWeek: claimableStartWeekForFetch,
      endWeek: claimableEndWeek,
    },
  });

  const GLW_TOKEN = addresses.glow.toLowerCase();
  const AMOUNT_MATCH_EPSILON_WEI = BigInt(10_000_000);
  const WEEK_97_START_TIMESTAMP = GENESIS_TIMESTAMP + 97 * 604800;

  for (const wallet of wallets) {
    const rewards = walletRewardsMap.get(wallet) || [];
    const inflationByWeek = new Map<number, bigint>();
    const pdByWeek = new Map<number, bigint>();

    // New: Track detailed rewards for region breakdown
    const detailedRewardsByWeek = new Map<
      number,
      {
        inflation: Array<{ amount: bigint; regionId: number }>;
        pd: Array<{ amount: bigint; regionId: number }>;
      }
    >();

    let maxWeek = -1;

    for (const r of rewards) {
      const week = Number(r.weekNumber);
      if (!Number.isFinite(week)) continue;
      maxWeek = week > maxWeek ? week : maxWeek;
      const regionId = r.regionId || 0; // Default to 0 (unknown) if missing

      if (!detailedRewardsByWeek.has(week)) {
        detailedRewardsByWeek.set(week, { inflation: [], pd: [] });
      }
      const entry = detailedRewardsByWeek.get(week)!;

      const inflation = safeBigInt(r.walletTotalGlowInflationReward);
      if (inflation > 0n) {
        inflationByWeek.set(
          week,
          (inflationByWeek.get(week) || 0n) + inflation
        );
        entry.inflation.push({ amount: inflation, regionId });
      }

      const pdRaw = safeBigInt(r.walletProtocolDepositFromLaunchpad);
      const recoveredGlw = protocolDepositReceivedGlwWei({
        amountRaw: pdRaw,
        asset: r.asset,
      });
      if (recoveredGlw > 0n) {
        pdByWeek.set(week, (pdByWeek.get(week) || 0n) + recoveredGlw);
        entry.pd.push({ amount: recoveredGlw, regionId });
      }
    }

    rewardsTimelineByWallet.set(wallet, {
      inflation: inflationByWeek,
      pd: pdByWeek,
      detailed: detailedRewardsByWeek,
    });

    // 1. PD claims (deterministic from nonce)
    const claimPdData =
      claimedPdWeeksByWallet.get(wallet) || new Map<number, number>();
    claimedPdWeeksByWalletState.set(wallet, claimPdData);

    // 2. Inflation claims (inferred from transfer amounts)
    const claims = allClaimsByWallet.get(wallet) || [];
    const claimedInflationWeeks = new Map<number, number>();

    for (const c of claims) {
      const token = String(c?.token || "").toLowerCase();
      if (token !== GLW_TOKEN) continue;
      const timestamp = Number(c?.timestamp);
      if (timestamp < WEEK_97_START_TIMESTAMP) continue;
      const source = String(c?.source || "");
      if (source !== "minerPool") continue;

      const amountWei = safeBigInt(c?.amount);
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
        if (secondBestDiff == null || diff < secondBestDiff)
          secondBestDiff = diff;
      }

      if (
        bestWeek != null &&
        bestDiff != null &&
        bestDiff <= AMOUNT_MATCH_EPSILON_WEI
      ) {
        // Disambiguate: only if second best is not also within epsilon
        if (
          secondBestDiff == null ||
          secondBestDiff > AMOUNT_MATCH_EPSILON_WEI
        ) {
          claimedInflationWeeks.set(bestWeek, timestamp);
        }
      }
    }
    claimedInflationWeeksByWalletState.set(wallet, claimedInflationWeeks);

    // Calculate "current" unclaimed for static result fields
    let currentUnclaimedWei = 0n;
    const effectiveEndWeek = Math.min(claimableEndWeek, maxWeek);
    if (effectiveEndWeek >= claimableStartWeek) {
      for (let w = claimableStartWeek; w <= effectiveEndWeek; w++) {
        const inflationWei = inflationByWeek.get(w) || 0n;
        const pdWei = pdByWeek.get(w) || 0n;
        if (inflationWei > 0n && !claimedInflationWeeks.has(w))
          currentUnclaimedWei += inflationWei;
        if (pdWei > 0n && !claimPdData.has(w)) currentUnclaimedWei += pdWei;
      }
    }

    unclaimedByWallet.set(wallet, {
      amountWei: currentUnclaimedWei,
      dataSource: "claims-api+control-api",
    });
  }

  const regionRewardsStart = nowMs();
  const {
    rawByWeek: regionRewardsRawByWeek,
    aggregateByWeek: regionRewardsByWeek,
  } = await loadRegionRewardsByWeek({
    startWeek,
    endWeek,
    debug,
  });
  recordTimingSafe(debug, {
    label: "compute.regionRewards.total",
    ms: nowMs() - regionRewardsStart,
    meta: {
      weeks: endWeek - startWeek + 1,
      fetchedWeeks: regionRewardsRawByWeek.size,
    },
  });

  const {
    steeringByWallet: precomputedSteeringByWallet,
    missingWallets: steeringFallbackWallets,
  } = hasSteeringRange
    ? await precomputeSteeringByWalletFromDb({
        wallets,
        startWeek,
        endWeek: steeringComputationEndWeek,
        regionRewardsByEpoch: regionRewardsRawByWeek,
        debug,
      })
    : {
        steeringByWallet: new Map<string, SteeringByWeekResult>(),
        missingWallets: new Set<string>(),
      };

  const hexWallets = wallets.filter(isHexWallet) as Array<`0x${string}`>;
  const liquidBatchStart = nowMs();
  const liquidByWalletBatch = await getLiquidGlwBalancesWeiBatch(
    hexWallets
  ).catch((error) => {
    console.error(
      `[impact-score] liquid balance batch fetch failed for wallets=${hexWallets.length}; using zero fallback`,
      error
    );
    const zeros = new Map<string, bigint>();
    for (const wallet of hexWallets) zeros.set(wallet.toLowerCase(), 0n);
    return zeros;
  });
  recordTimingSafe(debug, {
    label: "compute.walletInputs.liquidBatch",
    ms: nowMs() - liquidBatchStart,
    meta: {
      wallets: hexWallets.length,
      returned: liquidByWalletBatch.size,
    },
  });

  const concurrency = 8;
  const walletInputsStart = nowMs();
  const perWalletTimings: Array<
    | {
        wallet: string;
        ok: true;
        totalMs: number;
        liquidMs: number;
        unclaimedMs: number;
        steeringMs: number;
        liquidUsedFallback: boolean;
        steeringUsedFallback: boolean;
      }
    | {
        wallet: string;
        ok: false;
        totalMs: number;
        liquidMs: number;
        unclaimedMs: number;
        steeringMs: number;
        error: string;
      }
  > = [];
  for (let i = 0; i < wallets.length; i += concurrency) {
    const batch = wallets.slice(i, i + concurrency);
    const rows = await Promise.all(
      batch.map(async (wallet) => {
        const walletStart = nowMs();
        let liquidMs = 0;
        let unclaimedMs = 0;
        let steeringMs = 0;
        let liquidUsedFallback = false;

        try {
          const liquidStart = nowMs();
          const liquid = isHexWallet(wallet)
            ? liquidByWalletBatch.get(wallet.toLowerCase()) ?? 0n
            : BigInt(0);
          liquidUsedFallback = isHexWallet(wallet)
            ? !liquidByWalletBatch.has(wallet.toLowerCase())
            : false;
          liquidMs = nowMs() - liquidStart;

          const unclaimedStart = nowMs();
          const unclaimed = unclaimedByWallet.get(wallet) || {
            amountWei: 0n,
            dataSource: "claims-api+control-api" as const,
          };
          unclaimedMs = nowMs() - unclaimedStart;

          const steeringStart = nowMs();
          const precomputedSteering = precomputedSteeringByWallet.get(wallet);
          const steering =
            precomputedSteering && !steeringFallbackWallets.has(wallet)
              ? precomputedSteering
              : hasSteeringRange
                ? await getGctlSteeringByWeekWei({
                    walletAddress: wallet,
                    startWeek,
                    endWeek: steeringComputationEndWeek,
                    regionRewardsByEpoch: regionRewardsRawByWeek,
                  }).catch((error) => {
                    console.error(
                      `[impact-score] steering fetch failed for wallet=${wallet}`,
                      error
                    );
                    return getSteeringFallback({ startWeek, endWeek, error });
                  })
                : getSteeringFallback({
                    startWeek,
                    endWeek,
                    error: "No finalized steering weeks in requested range",
                  });
          steeringMs = nowMs() - steeringStart;

          const totalMs = nowMs() - walletStart;
          return {
            wallet,
            ok: true as const,
            liquid,
            unclaimed,
            steering,
            totalMs,
            liquidMs,
            unclaimedMs,
            steeringMs,
            liquidUsedFallback,
          };
        } catch (error) {
          const totalMs = nowMs() - walletStart;
          return {
            wallet,
            ok: false as const,
            totalMs,
            liquidMs,
            unclaimedMs,
            steeringMs,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    for (const r of rows) {
      if (!r.ok) {
        console.error("[impact-score] Failed to fetch wallet inputs:", {
          wallet: r.wallet,
          error: r.error,
        });
        perWalletTimings.push({
          wallet: r.wallet,
          ok: false,
          totalMs: r.totalMs,
          liquidMs: r.liquidMs,
          unclaimedMs: r.unclaimedMs,
          steeringMs: r.steeringMs,
          error: r.error,
        });
        continue;
      }

      liquidByWallet.set(r.wallet, r.liquid);
      unclaimedByWallet.set(r.wallet, r.unclaimed);
      steeringByWallet.set(r.wallet, r.steering);

      perWalletTimings.push({
        wallet: r.wallet,
        ok: true,
        totalMs: r.totalMs,
        liquidMs: r.liquidMs,
        unclaimedMs: r.unclaimedMs,
        steeringMs: r.steeringMs,
        liquidUsedFallback: r.liquidUsedFallback,
        steeringUsedFallback: r.steering.isFallback === true,
      });
    }
  }

  const okWalletTimingRows = perWalletTimings.filter((r) => r.ok) as Array<
    Extract<(typeof perWalletTimings)[number], { ok: true }>
  >;
  const failedWalletCount = perWalletTimings.length - okWalletTimingRows.length;
  const sumTotal = okWalletTimingRows.reduce((acc, r) => acc + r.totalMs, 0);
  const sumLiquid = okWalletTimingRows.reduce((acc, r) => acc + r.liquidMs, 0);
  const sumUnclaimed = okWalletTimingRows.reduce(
    (acc, r) => acc + r.unclaimedMs,
    0
  );
  const sumSteering = okWalletTimingRows.reduce(
    (acc, r) => acc + r.steeringMs,
    0
  );
  const maxTotal = okWalletTimingRows.reduce(
    (max, r) => (r.totalMs > max ? r.totalMs : max),
    0
  );
  const steeringFallbackCount = okWalletTimingRows.reduce(
    (acc, r) => acc + (r.steeringUsedFallback ? 1 : 0),
    0
  );
  const liquidFallbackCount = okWalletTimingRows.reduce(
    (acc, r) => acc + (r.liquidUsedFallback ? 1 : 0),
    0
  );
  const topSlowWallets = okWalletTimingRows
    .slice()
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10)
    .map((r) => ({
      wallet: r.wallet,
      totalMs: Math.round(r.totalMs * 10) / 10,
      liquidMs: Math.round(r.liquidMs * 10) / 10,
      unclaimedMs: Math.round(r.unclaimedMs * 10) / 10,
      steeringMs: Math.round(r.steeringMs * 10) / 10,
      liquidUsedFallback: r.liquidUsedFallback,
      steeringUsedFallback: r.steeringUsedFallback,
    }));

  recordTimingSafe(debug, {
    label: "compute.walletInputs.total",
    ms: nowMs() - walletInputsStart,
    meta: {
      wallets: wallets.length,
      concurrency,
      okWallets: okWalletTimingRows.length,
      failedWallets: failedWalletCount,
      liquidFallbackWallets: liquidFallbackCount,
      steeringFallbackWallets: steeringFallbackCount,
      avgMsPerWallet:
        okWalletTimingRows.length > 0
          ? Math.round((sumTotal / okWalletTimingRows.length) * 10) / 10
          : 0,
      maxMsPerWallet: Math.round(maxTotal * 10) / 10,
      sumMsByCall: {
        liquid: Math.round(sumLiquid * 10) / 10,
        unclaimed: Math.round(sumUnclaimed * 10) / 10,
        steering: Math.round(sumSteering * 10) / 10,
      },
      topSlowWallets,
    },
  });

  const farmDistributedTimelineByFarm = await farmDistributedTimelineByFarmPromise;
  const results: GlowImpactScoreResult[] = [];

  const steeringBoostByWeek = hasSteeringRange
    ? await getSteeringBoostByWeek({
        startWeek,
        endWeek: steeringComputationEndWeek,
        foundationWallets: EXCLUDED_LEADERBOARD_WALLETS,
        regionRewardsByWeek,
        debug,
      })
    : new Map<number, bigint>();

  const scoringStart = nowMs();
  for (const wallet of wallets) {
    const liquidGlwWei = liquidByWallet.get(wallet) || BigInt(0);
    const unclaimed = unclaimedByWallet.get(wallet) || {
      amountWei: BigInt(0),
      dataSource: "claims-api+control-api" as const,
    };
    const steering =
      steeringByWallet.get(wallet) ||
      getSteeringFallback({
        startWeek,
        endWeek,
        error: "Steering data missing (no fetch result stored for wallet)",
      });
    const applySteeringBoost =
      steeringBoostByWeek.size > 0 &&
      !excludedLeaderboardWalletsSet.has(wallet);

    const rewards = walletRewardsMap.get(wallet) || [];
    const protocolRecoveredByWeek = new Map<number, bigint>();
    const inflationByWeek = new Map<number, bigint>();

    for (const r of rewards) {
      const week = r.weekNumber;
      if (week < startWeek || week > endWeek) continue;
      const inflation = BigInt(r.walletTotalGlowInflationReward || "0");
      inflationByWeek.set(
        week,
        (inflationByWeek.get(week) || BigInt(0)) + inflation
      );

      // Only count protocol-deposit recovery once the week is finalized.
      if (week <= finalizedWeek) {
        const pdRaw = BigInt(r.walletProtocolDepositFromLaunchpad || "0");
        const recoveredGlw = protocolDepositReceivedGlwWei({
          amountRaw: pdRaw,
          asset: r.asset,
        });
        protocolRecoveredByWeek.set(
          week,
          (protocolRecoveredByWeek.get(week) || BigInt(0)) + recoveredGlw
        );
      }
    }

    const cashMinerWeeks = miningPurchaseWeeksByWallet.get(wallet) || new Set();
    const splitSegments = depositSplitHistoryByWallet.get(wallet) || [];
    const splitSegmentsByFarm = new Map<
      string,
      ControlApiDepositSplitHistorySegment[]
    >();
    for (const seg of splitSegments) {
      if (!splitSegmentsByFarm.has(seg.farmId))
        splitSegmentsByFarm.set(seg.farmId, []);
      splitSegmentsByFarm.get(seg.farmId)!.push(seg);
    }

    const farmStates = new Map<
      string,
      {
        split: SegmentState;
        principalWei: bigint;
        dist: TimelineState;
        regionId: number;
      }
    >();
    for (const [farmId, segs] of splitSegmentsByFarm) {
      const principalWei = principalByFarm.get(farmId) || BigInt(0);
      if (principalWei <= BigInt(0)) continue;
      const timeline = farmDistributedTimelineByFarm.get(farmId) || [];
      farmStates.set(farmId, {
        split: makeSegmentState(segs),
        principalWei,
        dist: makeTimelineState(timeline),
        regionId: regionByFarm.get(farmId) || 0,
      });
    }

    farmStatesByWallet.set(wallet, farmStates);

    let grossShareAtEndWeek = BigInt(0);
    for (const farm of farmStates.values()) {
      const splitScaled6 = getSplitScaled6AtWeek(farm.split, endWeek);
      if (splitScaled6 <= BigInt(0)) continue;
      grossShareAtEndWeek +=
        (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;
    }

    const purchasedGlwWei = glwPurchasesByWallet.get(wallet) || BigInt(0);
    const refundedGlwWei = glwRefundsByWallet.get(wallet) || BigInt(0);
    const netPurchasedGlwWei =
      purchasedGlwWei > refundedGlwWei
        ? purchasedGlwWei - refundedGlwWei
        : BigInt(0);
    const pendingDelegatedGlwWei =
      netPurchasedGlwWei > grossShareAtEndWeek
        ? netPurchasedGlwWei - grossShareAtEndWeek
        : BigInt(0);

    const netPurchasesByWeek = glwNetPurchasesByWalletWeek.get(wallet);
    let cumulativeNetPurchasesWei = BigInt(0);
    if (netPurchasesByWeek) {
      for (const [week, amountWei] of netPurchasesByWeek) {
        if (week < startWeek) cumulativeNetPurchasesWei += amountWei;
      }
      if (cumulativeNetPurchasesWei < 0n) cumulativeNetPurchasesWei = 0n;
    }

    let totalPointsScaled6 = BigInt(0);
    let rolloverPointsScaled6 = BigInt(0);
    let continuousPointsScaled6 = BigInt(0);
    let inflationPointsScaled6 = BigInt(0);
    let steeringPointsScaled6 = BigInt(0);
    let vaultBonusPointsScaled6 = BigInt(0);
    let totalInflationGlwWei = BigInt(0);
    let totalSteeringGlwWei = BigInt(0);
    let totalBasePointsPreMultiplierScaled6 = BigInt(0);
    let basePointsPreMultiplierThisWeekScaled6 = BigInt(0);

    let lastWeekPointsScaled6 = BigInt(0);
    const lastWeek = endWeek - 1;

    // Composition buckets (scaled6). These are multiplied the same way the score is.
    let compositionInflationScaled6 = BigInt(0);
    let compositionSteeringScaled6 = BigInt(0);
    let compositionVaultScaled6 = BigInt(0);
    let compositionWorthScaled6 = BigInt(0);

    let impactStreakWeeks = 0;
    let previousGrossShareWei = BigInt(0);
    for (let week = streakSeedStartWeek; week < startWeek; week++) {
      const hasCashMinerBonus = cashMinerWeeks.has(week);
      let grossShareWei = BigInt(0);
      for (const farm of farmStates.values()) {
        const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
        if (splitScaled6 <= BigInt(0)) continue;
        grossShareWei +=
          (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;
      }
      const hasImpactActionThisWeek =
        grossShareWei > previousGrossShareWei || hasCashMinerBonus;
      impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
      previousGrossShareWei = grossShareWei;
    }

    const weekly: WeeklyImpactRow[] = [];
    let endWeekMultiplier = 1;

    let delegatedActiveNow = BigInt(0);
    const totalPointsPerRegionScaled6 = new Map<string, bigint>();
    const totalWorthPointsPerRegionScaled6 = new Map<string, bigint>();
    const totalDirectPointsPerRegionScaled6 = new Map<string, bigint>();

    const walletSnapshots = liquidSnapshotByWalletWeek.get(wallet);
    const rewardTimeline = rewardsTimelineByWallet.get(wallet);
    const pdByWeek = rewardTimeline?.pd ?? new Map<number, bigint>();
    const pdCumulativeByWeek = new Map<number, bigint>();
    let pdRunning = 0n;
    for (let w = startWeek; w <= endWeek; w++) {
      pdRunning += pdByWeek.get(w) || 0n;
      pdCumulativeByWeek.set(w, pdRunning);
    }

    for (let week = startWeek; week <= endWeek; week++) {
      let delegatedActive = BigInt(0);
      let grossShareWei = BigInt(0);

      const weeklyRegionPoints = new Map<string, bigint>();
      const addToRegion = (rid: number | string, pts: bigint) => {
        if (pts <= 0n) return;
        const k = String(rid);
        weeklyRegionPoints.set(k, (weeklyRegionPoints.get(k) || 0n) + pts);
      };

      for (const farm of farmStates.values()) {
        const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
        if (splitScaled6 <= BigInt(0)) continue;
        grossShareWei +=
          (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;

        // Freeze recovery for unfinalized weeks to avoid reducing delegatedActive
        // before rewards are finalized.
        const recoveryWeek = week <= finalizedWeek ? week : finalizedWeek;
        const cumulativeDistributed = getCumulativeDistributedGlwWeiAtWeek(
          farm.dist,
          recoveryWeek
        );
        const remaining = clampToZero(
          farm.principalWei - cumulativeDistributed
        );
        const farmDelegated = (remaining * splitScaled6) / SPLIT_SCALE_SCALED6;
        delegatedActive += farmDelegated;

        // Region Logic: Vault Bonus (Direct)
        // Delegated GLW earns vault bonus (0.005/GLW) attributed to the farm's region.
        // The continuous GLW Worth points (0.001/GLW) are handled separately via
        // glowWorthWeekWei and distributed by emission share across all regions.
        const vaultPts = glwWeiToPointsScaled6(
          farmDelegated,
          VAULT_BONUS_POINTS_PER_GLW_SCALED6
        );
        addToRegion(farm.regionId, vaultPts);
      }
      if (netPurchasesByWeek) {
        cumulativeNetPurchasesWei += netPurchasesByWeek.get(week) || 0n;
        if (cumulativeNetPurchasesWei < 0n) cumulativeNetPurchasesWei = 0n;
      }
      const pendingForWeek =
        cumulativeNetPurchasesWei > grossShareWei
          ? cumulativeNetPurchasesWei - grossShareWei
          : BigInt(0);
      const delegatedActiveForDisplay = delegatedActive + pendingForWeek;

      if (week === endWeek) delegatedActiveNow = delegatedActive;
      const inflationGlwWei = inflationByWeek.get(week) || BigInt(0);
      const steeringGlwWei = steering.byWeek.get(week) || BigInt(0);
      const steeringBoostScaled6 = applySteeringBoost
        ? steeringBoostByWeek.get(week) ?? MULTIPLIER_SCALE_SCALED6
        : MULTIPLIER_SCALE_SCALED6;

      // Region Logic: Inflation (Direct)
      const detailedRewards = rewardsTimelineByWallet
        .get(wallet)
        ?.detailed?.get(week);
      if (detailedRewards) {
        for (const inf of detailedRewards.inflation) {
          const pts = glwWeiToPointsScaled6(
            inf.amount,
            INFLATION_POINTS_PER_GLW_SCALED6
          );
          addToRegion(inf.regionId, pts);
        }
      } else if (inflationGlwWei > 0n) {
        const pts = glwWeiToPointsScaled6(
          inflationGlwWei,
          INFLATION_POINTS_PER_GLW_SCALED6
        );
        addToRegion(0, pts);
      }

      // Region Logic: Steering (Direct)
      const steeringMap = steering.byWeekAndRegion?.get(week);
      if (steeringMap) {
        for (const [rid, amount] of steeringMap) {
          let pts = glwWeiToPointsScaled6(
            amount,
            STEERING_POINTS_PER_GLW_SCALED6
          );
          if (steeringBoostScaled6 !== MULTIPLIER_SCALE_SCALED6) {
            pts = applyMultiplierScaled6({
              pointsScaled6: pts,
              multiplierScaled6: steeringBoostScaled6,
            });
          }
          addToRegion(rid, pts);
        }
      } else if (steeringGlwWei > 0n) {
        let pts = glwWeiToPointsScaled6(
          steeringGlwWei,
          STEERING_POINTS_PER_GLW_SCALED6
        );
        if (steeringBoostScaled6 !== MULTIPLIER_SCALE_SCALED6) {
          pts = applyMultiplierScaled6({
            pointsScaled6: pts,
            multiplierScaled6: steeringBoostScaled6,
          });
        }
        addToRegion(0, pts);
      }

      totalInflationGlwWei += inflationGlwWei;
      totalSteeringGlwWei += steeringGlwWei;

      const inflationPts = glwWeiToPointsScaled6(
        inflationGlwWei,
        INFLATION_POINTS_PER_GLW_SCALED6
      );
      let steeringPts = glwWeiToPointsScaled6(
        steeringGlwWei,
        STEERING_POINTS_PER_GLW_SCALED6
      );
      if (steeringBoostScaled6 !== MULTIPLIER_SCALE_SCALED6) {
        steeringPts = applyMultiplierScaled6({
          pointsScaled6: steeringPts,
          multiplierScaled6: steeringBoostScaled6,
        });
      }
      const vaultPts = glwWeiToPointsScaled6(
        delegatedActive,
        VAULT_BONUS_POINTS_PER_GLW_SCALED6
      );

      const rolloverPre = addScaled6Points([
        inflationPts,
        steeringPts,
        vaultPts,
      ]);
      totalBasePointsPreMultiplierScaled6 += rolloverPre;

      const hasCashMinerBonus = cashMinerWeeks.has(week);
      const baseMultiplierScaled6 = hasCashMinerBonus
        ? BASE_CASH_MINER_MULTIPLIER_SCALED6
        : BASE_STANDARD_MULTIPLIER_SCALED6;
      const baseMultiplier = hasCashMinerBonus ? 3 : 1;

      const hasImpactActionThisWeek =
        grossShareWei > previousGrossShareWei || hasCashMinerBonus;
      impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
      previousGrossShareWei = grossShareWei;
      const streakBonusScaled6 =
        getStreakBonusMultiplierScaled6(impactStreakWeeks);
      const totalMultiplierScaled6 = baseMultiplierScaled6 + streakBonusScaled6;
      const streakBonusMultiplier =
        Number(streakBonusScaled6) / Number(MULTIPLIER_SCALE_SCALED6);
      const rolloverMultiplier =
        Number(totalMultiplierScaled6) / Number(MULTIPLIER_SCALE_SCALED6);

      const rollover = applyMultiplierScaled6({
        pointsScaled6: rolloverPre,
        multiplierScaled6: totalMultiplierScaled6,
      });

      // Prefer end-of-week snapshot when it's real; fall back to live balance
      // when the snapshot is forward-filled or missing.
      const snapshotEntry = walletSnapshots?.get(week);
      const snapshotBalance = snapshotEntry?.balanceWei;
      const snapshotSource = snapshotEntry?.source;
      let liquidWeekWei =
        snapshotSource === "snapshot" && snapshotBalance != null
          ? snapshotBalance
          : liquidGlwWei;

      // Calculate Historical Unclaimed for this specific week
      const weekEndTimestamp = GENESIS_TIMESTAMP + (week + 1) * 604800;
      const pdClaimableUpToWeek = week - 4;
      const claimPdData = claimedPdWeeksByWalletState.get(wallet);
      const claimInflationData = claimedInflationWeeksByWalletState.get(wallet);
      let historicalUnclaimedWei = 0n;

      if (rewardTimeline) {
        const inflationClaimableUpToWeek = week - 3;

        if (rewardTimeline.detailed) {
          const detailed = rewardTimeline.detailed;
          for (const [rw, entry] of detailed) {
            // Inflation
            if (rw <= inflationClaimableUpToWeek) {
              const claimTimestamp = claimInflationData?.get(rw);
              if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
                for (const item of entry.inflation) {
                  historicalUnclaimedWei += item.amount;
                }
              }
            }
            // PD
            if (rw <= pdClaimableUpToWeek) {
              const claimTimestamp = claimPdData?.get(rw);
              if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
                for (const item of entry.pd) {
                  historicalUnclaimedWei += item.amount;
                }
              }
            }
          }
        } else {
          // Fallback (no region info)
          for (const [rw, amount] of rewardTimeline.inflation) {
            if (rw <= inflationClaimableUpToWeek) {
              const claimTimestamp = claimInflationData?.get(rw);
              // If never claimed OR claimed AFTER this week's end -> It was unclaimed at this week
              if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
                historicalUnclaimedWei += amount;
              }
            }
          }
          for (const [rw, amount] of rewardTimeline.pd) {
            if (rw <= pdClaimableUpToWeek) {
              const claimTimestamp = claimPdData?.get(rw);
              // If never claimed OR claimed AFTER this week's end -> It was unclaimed at this week
              if (!claimTimestamp || claimTimestamp > weekEndTimestamp) {
                historicalUnclaimedWei += amount;
              }
            }
          }
          if (historicalUnclaimedWei > 0n) {
            // No region distribution for historical unclaimed here
          }
        }
      } else {
        // Fallback for single-wallet query or missing timeline: use the static unclaimed amount
        // which is less accurate historically but better than nothing.
        historicalUnclaimedWei = unclaimed.amountWei;
      }

      // Region Logic: Apply Multipliers
      for (const [ridKey, pts] of weeklyRegionPoints) {
        const finalPts = applyMultiplierScaled6({
          pointsScaled6: pts,
          multiplierScaled6: totalMultiplierScaled6,
        });
        totalPointsPerRegionScaled6.set(
          ridKey,
          (totalPointsPerRegionScaled6.get(ridKey) || 0n) + finalPts
        );
        totalDirectPointsPerRegionScaled6.set(
          ridKey,
          (totalDirectPointsPerRegionScaled6.get(ridKey) || 0n) + finalPts
        );
      }

      const pdCumulative = pdCumulativeByWeek.get(week) || 0n;
      let pdClaimableCumulative = 0n;
      if (pdClaimableUpToWeek >= startWeek) {
        const claimWeek = Math.min(pdClaimableUpToWeek, endWeek);
        pdClaimableCumulative = pdCumulativeByWeek.get(claimWeek) || 0n;
      }
      const pendingRecoveredWei =
        pdCumulative > pdClaimableCumulative
          ? pdCumulative - pdClaimableCumulative
          : 0n;

      // Weekly GlowWorth = liquid snapshot + delegatedActive + unclaimed + recovered-but-not-claimable.
      // These points are distributed by emission share across all regions in glowWorthPoints.
      const glowWorthWeekWei =
        liquidWeekWei +
        delegatedActive +
        historicalUnclaimedWei +
        pendingRecoveredWei;
      const glowWorthWeekWeiDisplay = glowWorthWeekWei + pendingForWeek;
      const continuousPts = glwWeiToPointsScaled6(
        glowWorthWeekWei,
        GLOW_WORTH_POINTS_PER_GLW_SCALED6
      );
      totalBasePointsPreMultiplierScaled6 += continuousPts;
      if (week === endWeek) {
        basePointsPreMultiplierThisWeekScaled6 = rolloverPre + continuousPts;
      }
      const continuousPtsMultiplied = applyMultiplierScaled6({
        pointsScaled6: continuousPts,
        multiplierScaled6: totalMultiplierScaled6,
      });

      // Distribute worth points by emission share for the aggregate breakdown
      const emissionData = regionRewardsByWeek.get(week);
      if (
        continuousPtsMultiplied > 0n &&
        emissionData &&
        emissionData.totalGlw > 0n
      ) {
        for (const [rid, amount] of emissionData.byRegion) {
          const distributedWorth =
            (continuousPtsMultiplied * amount) / emissionData.totalGlw;
          const k = String(rid);
          totalWorthPointsPerRegionScaled6.set(
            k,
            (totalWorthPointsPerRegionScaled6.get(k) || 0n) + distributedWorth
          );
          totalPointsPerRegionScaled6.set(
            k,
            (totalPointsPerRegionScaled6.get(k) || 0n) + distributedWorth
          );
        }
      } else if (continuousPtsMultiplied > 0n) {
        const k = "0";
        totalWorthPointsPerRegionScaled6.set(
          k,
          (totalWorthPointsPerRegionScaled6.get(k) || 0n) +
            continuousPtsMultiplied
        );
        totalPointsPerRegionScaled6.set(
          k,
          (totalPointsPerRegionScaled6.get(k) || 0n) + continuousPtsMultiplied
        );
      }

      const totalWeekPts = rollover + continuousPtsMultiplied;

      const inflationMultiplied = applyMultiplierScaled6({
        pointsScaled6: inflationPts,
        multiplierScaled6: totalMultiplierScaled6,
      });
      const steeringMultiplied = applyMultiplierScaled6({
        pointsScaled6: steeringPts,
        multiplierScaled6: totalMultiplierScaled6,
      });
      const vaultMultiplied = applyMultiplierScaled6({
        pointsScaled6: vaultPts,
        multiplierScaled6: totalMultiplierScaled6,
      });

      totalPointsScaled6 += totalWeekPts;
      rolloverPointsScaled6 += rollover;
      continuousPointsScaled6 += continuousPtsMultiplied;
      inflationPointsScaled6 += inflationMultiplied;
      steeringPointsScaled6 += steeringMultiplied;
      vaultBonusPointsScaled6 += vaultMultiplied;

      compositionInflationScaled6 += inflationMultiplied;
      compositionSteeringScaled6 += steeringMultiplied;
      compositionVaultScaled6 += vaultMultiplied;
      compositionWorthScaled6 += continuousPtsMultiplied;

      if (week === lastWeek && lastWeek >= startWeek) {
        // `lastWeekPoints` is intended to represent the isolated points earned
        // in the last completed week (velocity), not the cumulative total.
        lastWeekPointsScaled6 = totalWeekPts;
      }

      if (week === endWeek) endWeekMultiplier = rolloverMultiplier;

      if (includeWeeklyBreakdown || includeWeeklyRegionBreakdown) {
        const weeklyPointsPerRegionRecord: Record<string, string> = {};
        for (const [rid, pts] of weeklyRegionPoints) {
          // Apply multiplier here too for the weekly view?
          // The score logic applies multiplier before adding to total.
          // Yes, weekly breakdown usually shows "final points" for that week.
          // But wait, `weeklyRegionPoints` in my loop holds PRE-MULTIPLIER points?
          // "Region Logic: Apply Multipliers and Accumulate" loop calculates `finalPts` and adds to `total`.
          // But `weeklyRegionPoints` itself is not modified in place to be post-multiplier.
          // So I need to apply multiplier here.
          const finalPts = applyMultiplierScaled6({
            pointsScaled6: pts,
            multiplierScaled6: totalMultiplierScaled6,
          });
          weeklyPointsPerRegionRecord[rid] = formatPointsScaled6(finalPts);
        }

        weekly.push({
          weekNumber: week,
          inflationGlwWei: inflationGlwWei.toString(),
          steeringGlwWei: steeringGlwWei.toString(),
          delegatedActiveGlwWei: delegatedActiveForDisplay.toString(),
          protocolDepositRecoveredGlwWei: (week <= finalizedWeek
            ? protocolRecoveredByWeek.get(week) || BigInt(0)
            : BigInt(0)
          ).toString(),
          liquidGlwWei: liquidWeekWei.toString(),
          unclaimedGlwWei: historicalUnclaimedWei.toString(),
          inflationPoints: formatPointsScaled6(inflationPts),
          steeringPoints: formatPointsScaled6(steeringPts),
          vaultBonusPoints: formatPointsScaled6(vaultPts),
          rolloverPointsPreMultiplier: formatPointsScaled6(rolloverPre),
          rolloverMultiplier,
          rolloverPoints: formatPointsScaled6(rollover),
          glowWorthGlwWei: glowWorthWeekWeiDisplay.toString(),
          continuousPoints: formatPointsScaled6(continuousPtsMultiplied),
          totalPoints: formatPointsScaled6(totalWeekPts),
          hasCashMinerBonus,
          baseMultiplier,
          streakBonusMultiplier,
          impactStreakWeeks,
          pointsPerRegion: weeklyPointsPerRegionRecord,
        });
      }
    }

    const delegatedActiveEffectiveWei =
      delegatedActiveNow + pendingDelegatedGlwWei;

    // Current glow-worth uses the live on-chain balance (not frozen), while
    // weekly history uses the finalized-week freeze logic.
    const totalPdCumulative = pdCumulativeByWeek.get(endWeek) || 0n;
    let claimablePdCumulative = 0n;
    if (claimableEndWeek >= startWeek) {
      const claimWeek = Math.min(claimableEndWeek, endWeek);
      claimablePdCumulative = pdCumulativeByWeek.get(claimWeek) || 0n;
    }
    const pendingRecoveredCurrentWei =
      totalPdCumulative > claimablePdCumulative
        ? totalPdCumulative - claimablePdCumulative
        : 0n;

    const glowWorthNowWei =
      liquidGlwWei +
      delegatedActiveEffectiveWei +
      unclaimed.amountWei +
      pendingRecoveredCurrentWei;

    const effectiveLastWeekPoints =
      lastWeek >= startWeek ? lastWeekPointsScaled6 : BigInt(0);
    const activeMultiplier = endWeekMultiplier > 1;
    const hasMinerMultiplier = cashMinerWeeks.has(endWeek);

    const pointsPerRegionRecord: Record<string, string> = {};
    for (const [rid, pts] of totalPointsPerRegionScaled6) {
      pointsPerRegionRecord[rid] = formatPointsScaled6(pts);
    }

    const scoreResult: GlowImpactScoreResult = {
      walletAddress: wallet,
      weekRange: { startWeek, endWeek },
      glowWorth: {
        walletAddress: wallet,
        liquidGlwWei: liquidGlwWei.toString(),
        delegatedActiveGlwWei: delegatedActiveEffectiveWei.toString(),
        pendingRecoveredGlwWei: pendingRecoveredCurrentWei.toString(),
        unclaimedGlwRewardsWei: unclaimed.amountWei.toString(),
        glowWorthWei: glowWorthNowWei.toString(),
        dataSources: {
          liquidGlw: "onchain",
          delegatedActiveGlw: "db+control-api",
          pendingRecoveredGlw: "control-api",
          unclaimedGlwRewards: unclaimed.dataSource,
        },
      },
      ...(steering.isFallback
        ? { warnings: { steering: steering.error || "Steering fallback used" } }
        : {}),
      pointsPerRegion: pointsPerRegionRecord,
      regionBreakdown: includeRegionBreakdown
        ? (function () {
            const allRegionIds = new Set<string>();
            for (const rid of totalDirectPointsPerRegionScaled6.keys())
              allRegionIds.add(rid);
            for (const rid of totalWorthPointsPerRegionScaled6.keys())
              allRegionIds.add(rid);

            const breakdown: RegionBreakdown[] = [];
            for (const ridKey of allRegionIds) {
              const direct =
                totalDirectPointsPerRegionScaled6.get(ridKey) || 0n;
              const worth = totalWorthPointsPerRegionScaled6.get(ridKey) || 0n;

              breakdown.push({
                regionId: parseInt(ridKey) || 0,
                directPoints: formatPointsScaled6(direct),
                glowWorthPoints: formatPointsScaled6(worth),
              });
            }
            return breakdown.sort((a, b) => b.regionId - a.regionId);
          })()
        : undefined,
      totals: {
        totalPoints: formatPointsScaled6(totalPointsScaled6),
        rolloverPoints: formatPointsScaled6(rolloverPointsScaled6),
        continuousPoints: formatPointsScaled6(continuousPointsScaled6),
        inflationPoints: formatPointsScaled6(inflationPointsScaled6),
        steeringPoints: formatPointsScaled6(steeringPointsScaled6),
        vaultBonusPoints: formatPointsScaled6(vaultBonusPointsScaled6),
        worthPoints: formatPointsScaled6(continuousPointsScaled6),
        basePointsPreMultiplierScaled6: formatPointsScaled6(
          totalBasePointsPreMultiplierScaled6
        ),
        basePointsPreMultiplierScaled6ThisWeek: formatPointsScaled6(
          basePointsPreMultiplierThisWeekScaled6
        ),
        totalInflationGlwWei: totalInflationGlwWei.toString(),
        totalSteeringGlwWei: totalSteeringGlwWei.toString(),
      },
      composition: {
        steeringPoints: formatPointsScaled6(compositionSteeringScaled6),
        inflationPoints: formatPointsScaled6(compositionInflationScaled6),
        worthPoints: formatPointsScaled6(compositionWorthScaled6),
        vaultPoints: formatPointsScaled6(compositionVaultScaled6),
      },
      lastWeekPoints: formatPointsScaled6(effectiveLastWeekPoints),
      activeMultiplier,
      hasMinerMultiplier,
      endWeekMultiplier,
      weekly,
    };

    results.push(
      excludedLeaderboardWalletsSet.has(wallet)
        ? zeroOutImpactScoreResult(scoreResult)
        : scoreResult
    );
  }
  recordTimingSafe(debug, {
    label: "compute.scoringLoop",
    ms: nowMs() - scoringStart,
    meta: {
      wallets: wallets.length,
      startWeek,
      endWeek,
      includeWeeklyBreakdown,
    },
  });

  // Compute weekly region breakdown if requested
  if (includeWeeklyRegionBreakdown) {
    const weeklyRegionBreakdownStart = nowMs();
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const wallet = result.walletAddress;
      if (excludedLeaderboardWalletsSet.has(wallet.toLowerCase())) {
        result.weeklyRegionBreakdown = [];
        continue;
      }
      const rewards = walletRewardsMap.get(wallet) || [];
      const steering = steeringByWallet.get(wallet);
      const applySteeringBoost = steeringBoostByWeek.size > 0;
      const weeklyRegionBreakdown: WeeklyRegionBreakdown[] = [];

      for (const weeklyRow of result.weekly) {
        const week = weeklyRow.weekNumber;
        const steeringBoostScaled6 = applySteeringBoost
          ? steeringBoostByWeek.get(week) ?? MULTIPLIER_SCALE_SCALED6
          : MULTIPLIER_SCALE_SCALED6;
        const regionPointsMap = new Map<
          number,
          {
            inflationPointsScaled6: bigint;
            steeringPointsScaled6: bigint;
            vaultBonusPointsScaled6: bigint;
            glowWorthPointsScaled6: bigint;
          }
        >();

        // 1. Inflation points for this week (from rewards history)
        for (const r of rewards) {
          if (r.weekNumber !== week) continue;
          const regionId = r.regionId;
          if (regionId == null) continue;

          const inflation = BigInt(r.walletTotalGlowInflationReward || "0");
          const inflationPts = glwWeiToPointsScaled6(
            inflation,
            INFLATION_POINTS_PER_GLW_SCALED6
          );

          const current = regionPointsMap.get(regionId) || {
            inflationPointsScaled6: 0n,
            steeringPointsScaled6: 0n,
            vaultBonusPointsScaled6: 0n,
            glowWorthPointsScaled6: 0n,
          };
          current.inflationPointsScaled6 += inflationPts;
          regionPointsMap.set(regionId, current);
        }

        // 2. Steering points for this week (from steering history)
        const regionMap = steering?.byWeekAndRegion?.get(week);
        if (regionMap) {
          for (const [regionId, steeringGlwWei] of regionMap) {
            let steeringPts = glwWeiToPointsScaled6(
              steeringGlwWei,
              STEERING_POINTS_PER_GLW_SCALED6
            );
            if (steeringBoostScaled6 !== MULTIPLIER_SCALE_SCALED6) {
              steeringPts = applyMultiplierScaled6({
                pointsScaled6: steeringPts,
                multiplierScaled6: steeringBoostScaled6,
              });
            }
            const current = regionPointsMap.get(regionId) || {
              inflationPointsScaled6: 0n,
              steeringPointsScaled6: 0n,
              vaultBonusPointsScaled6: 0n,
              glowWorthPointsScaled6: 0n,
            };
            current.steeringPointsScaled6 += steeringPts;
            regionPointsMap.set(regionId, current);
          }
        }

        // 3. Vault bonus points - attribute to each farm's region (same as main scoring loop)
        const farmStates = farmStatesByWallet.get(wallet);
        if (farmStates) {
          for (const farm of farmStates.values()) {
            const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
            if (splitScaled6 <= BigInt(0)) continue;

            const recoveryWeek = week <= finalizedWeek ? week : finalizedWeek;
            const cumulativeDistributed = getCumulativeDistributedGlwWeiAtWeek(
              farm.dist,
              recoveryWeek
            );
            const remaining = clampToZero(
              farm.principalWei - cumulativeDistributed
            );
            const farmDelegated =
              (remaining * splitScaled6) / SPLIT_SCALE_SCALED6;
            if (farmDelegated <= 0n) continue;

            const vaultPts = glwWeiToPointsScaled6(
              farmDelegated,
              VAULT_BONUS_POINTS_PER_GLW_SCALED6
            );

            const current = regionPointsMap.get(farm.regionId) || {
              inflationPointsScaled6: 0n,
              steeringPointsScaled6: 0n,
              vaultBonusPointsScaled6: 0n,
              glowWorthPointsScaled6: 0n,
            };
            current.vaultBonusPointsScaled6 += vaultPts;
            regionPointsMap.set(farm.regionId, current);
          }
        }

        // Apply weekly multiplier to all direct points (Inflation, Steering, Vault)
        const multiplierScaled6 = BigInt(
          Math.round(weeklyRow.rolloverMultiplier * 1_000_000)
        );
        for (const [regionId, points] of regionPointsMap.entries()) {
          points.inflationPointsScaled6 = applyMultiplierScaled6({
            pointsScaled6: points.inflationPointsScaled6,
            multiplierScaled6,
          });
          points.steeringPointsScaled6 = applyMultiplierScaled6({
            pointsScaled6: points.steeringPointsScaled6,
            multiplierScaled6,
          });
          points.vaultBonusPointsScaled6 = applyMultiplierScaled6({
            pointsScaled6: points.vaultBonusPointsScaled6,
            multiplierScaled6,
          });
        }

        // 4. GlowWorth continuous points for this week (multiplier already applied in weeklyRow.continuousPoints)
        // See "GLOW WORTH REGIONAL DISTRIBUTION" comment above for the rationale
        // on distributing worth across all regions with emissions.
        const weeklyWorthPts = BigInt(
          Math.floor(parseFloat(weeklyRow.continuousPoints) * 1_000_000)
        );
        const weekEmissions = regionRewardsByWeek.get(week);
        if (weeklyWorthPts > 0n && weekEmissions) {
          const totalEmissions = Array.from(
            weekEmissions.byRegion.values()
          ).reduce((sum, val) => sum + val, 0n);
          if (totalEmissions > 0n) {
            // Distribute worth points across ALL regions that had emissions this week.
            // Glow Worth is passive ownership - a GLW holder earns from every region
            // proportional to emissions, even without direct participation there.
            for (const [
              regionId,
              regionEmissions,
            ] of weekEmissions.byRegion.entries()) {
              const current = regionPointsMap.get(regionId) || {
                inflationPointsScaled6: 0n,
                steeringPointsScaled6: 0n,
                vaultBonusPointsScaled6: 0n,
                glowWorthPointsScaled6: 0n,
              };
              const distributedWorth =
                (weeklyWorthPts * regionEmissions) / totalEmissions;
              current.glowWorthPointsScaled6 += distributedWorth;
              regionPointsMap.set(regionId, current);
            }
          }
        }

        // Convert this week's region map to the output format
        for (const [regionId, points] of regionPointsMap.entries()) {
          const directTotal =
            points.inflationPointsScaled6 +
            points.steeringPointsScaled6 +
            points.vaultBonusPointsScaled6;

          weeklyRegionBreakdown.push({
            weekNumber: week,
            regionId,
            inflationPoints: formatPointsScaled6(points.inflationPointsScaled6),
            steeringPoints: formatPointsScaled6(points.steeringPointsScaled6),
            vaultBonusPoints: formatPointsScaled6(
              points.vaultBonusPointsScaled6
            ),
            glowWorthPoints: formatPointsScaled6(points.glowWorthPointsScaled6),
            directPoints: formatPointsScaled6(directTotal),
          });
        }
      }
      result.weeklyRegionBreakdown = weeklyRegionBreakdown;
    }
    recordTimingSafe(debug, {
      label: "compute.weeklyRegionBreakdown",
      ms: nowMs() - weeklyRegionBreakdownStart,
      meta: { wallets: results.length },
    });
  }

  recordTimingSafe(debug, {
    label: "compute.total",
    ms: nowMs() - overallStart,
    meta: {
      wallets: wallets.length,
      startWeek,
      endWeek,
      includeWeeklyBreakdown,
      includeRegionBreakdown,
    },
  });

  return results;
}

async function getHasMiningCenterMultiplierThisWeek(params: {
  walletAddress: string;
  weekNumber: number;
}): Promise<boolean> {
  const { walletAddress, weekNumber } = params;
  const wallet = walletAddress.toLowerCase();
  const startTimestamp = GENESIS_TIMESTAMP + weekNumber * 604800;
  const now = Math.floor(Date.now() / 1000);

  const rows = await db
    .select({ id: fractionSplits.id })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        eq(fractionSplits.buyer, wallet),
        eq(fractions.type, "mining-center"),
        gte(fractionSplits.timestamp, startTimestamp),
        lte(fractionSplits.timestamp, now)
      )
    )
    .limit(1);

  return rows.length > 0;
}

async function getImpactStreakSnapshot(params: {
  walletAddress: string;
  weekNumber: number;
}): Promise<{
  impactStreakWeeks: number;
  streakAsOfPreviousWeek: number;
  hasImpactActionThisWeek: boolean;
  hasMinerMultiplier: boolean;
  baseMultiplier: number;
  streakBonusMultiplier: number;
  totalMultiplierScaled6: bigint;
  totalMultiplier: number;
}> {
  const { walletAddress, weekNumber } = params;
  const wallet = walletAddress.toLowerCase();

  const streakSeedStartWeek = Math.max(weekNumber - STREAK_BONUS_CAP_WEEKS, 0);
  const cashMinerWeeks = new Set<number>();
  const startTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const now = Math.floor(Date.now() / 1000);

  // Miner purchases affect the base multiplier + streak eligibility.
  const miningRows = await db
    .select({
      buyer: fractionSplits.buyer,
      timestamp: fractionSplits.timestamp,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        eq(fractionSplits.buyer, wallet),
        eq(fractions.type, "mining-center"),
        gte(fractionSplits.timestamp, startTimestamp),
        lte(fractionSplits.timestamp, now)
      )
    );
  for (const row of miningRows) {
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > weekNumber) continue;
    cashMinerWeeks.add(week);
  }

  let splitSegments: ControlApiDepositSplitHistorySegment[] = [];
  try {
    const m = await fetchDepositSplitsHistoryBatch({
      wallets: [wallet],
      startWeek: streakSeedStartWeek,
      endWeek: weekNumber,
    });
    splitSegments = m.get(wallet) || [];
  } catch (e) {
    console.error("[impact-score] deposit split history fetch failed", e);
    splitSegments = [];
  }

  const farmIds = Array.from(new Set(splitSegments.map((s) => s.farmId)));
  const principalByFarm = new Map<string, bigint>();
  if (farmIds.length > 0) {
    const rows = await db
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
    for (const row of rows) {
      if (!row.farmId) continue;
      const amountWei = safeBigInt(row.paymentAmount);
      if (amountWei <= BigInt(0)) continue;
      principalByFarm.set(
        row.farmId,
        (principalByFarm.get(row.farmId) || BigInt(0)) + amountWei
      );
    }
  }

  const splitSegmentsByFarm = new Map<
    string,
    ControlApiDepositSplitHistorySegment[]
  >();
  for (const seg of splitSegments) {
    if (!principalByFarm.has(seg.farmId)) continue;
    if (!splitSegmentsByFarm.has(seg.farmId))
      splitSegmentsByFarm.set(seg.farmId, []);
    splitSegmentsByFarm.get(seg.farmId)!.push(seg);
  }

  const farmStates = new Map<
    string,
    { split: SegmentState; principalWei: bigint }
  >();
  for (const [farmId, segs] of splitSegmentsByFarm) {
    const principalWei = principalByFarm.get(farmId) || BigInt(0);
    if (principalWei <= BigInt(0)) continue;
    farmStates.set(farmId, { split: makeSegmentState(segs), principalWei });
  }

  let impactStreakWeeks = 0;
  let streakAsOfPreviousWeek = 0;
  let previousGrossShareWei = BigInt(0);
  let hasImpactActionThisWeek = false;

  for (let week = streakSeedStartWeek; week <= weekNumber; week++) {
    let grossShareWei = BigInt(0);
    for (const farm of farmStates.values()) {
      const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
      if (splitScaled6 <= BigInt(0)) continue;
      grossShareWei += (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;
    }

    const hasCashMinerBonus = cashMinerWeeks.has(week);
    const hasActionThisWeek =
      grossShareWei > previousGrossShareWei || hasCashMinerBonus;

    // Track streak as of previous week (before current week is evaluated)
    if (week === weekNumber) {
      streakAsOfPreviousWeek = impactStreakWeeks;
      hasImpactActionThisWeek = hasActionThisWeek;
    }

    impactStreakWeeks = hasActionThisWeek ? impactStreakWeeks + 1 : 0;
    previousGrossShareWei = grossShareWei;
  }

  const hasMinerMultiplier = cashMinerWeeks.has(weekNumber);
  const baseMultiplierScaled6 = hasMinerMultiplier
    ? BASE_CASH_MINER_MULTIPLIER_SCALED6
    : BASE_STANDARD_MULTIPLIER_SCALED6;
  const baseMultiplier = hasMinerMultiplier ? 3 : 1;
  const streakBonusScaled6 = getStreakBonusMultiplierScaled6(impactStreakWeeks);
  const totalMultiplierScaled6 = baseMultiplierScaled6 + streakBonusScaled6;

  return {
    impactStreakWeeks,
    streakAsOfPreviousWeek,
    hasImpactActionThisWeek,
    hasMinerMultiplier,
    baseMultiplier,
    streakBonusMultiplier:
      Number(streakBonusScaled6) / Number(MULTIPLIER_SCALE_SCALED6),
    totalMultiplierScaled6,
    totalMultiplier:
      Number(totalMultiplierScaled6) / Number(MULTIPLIER_SCALE_SCALED6),
  };
}

export async function getCurrentWeekProjection(
  walletAddress: string,
  glowWorth?: GlowWorthResult
): Promise<CurrentWeekProjection> {
  const weekNumber = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const wallet = walletAddress.toLowerCase();
  if (excludedLeaderboardWalletsSet.has(wallet)) {
    return {
      weekNumber,
      hasMinerMultiplier: false,
      hasSteeringStake: false,
      impactStreakWeeks: 0,
      streakAsOfPreviousWeek: 0,
      hasImpactActionThisWeek: false,
      baseMultiplier: 1,
      streakBonusMultiplier: 0,
      totalMultiplier: 1,
      projectedPoints: {
        steeringGlwWei: ZERO_WEI_STRING,
        inflationGlwWei: ZERO_WEI_STRING,
        delegatedGlwWei: ZERO_WEI_STRING,
        glowWorthWei: ZERO_WEI_STRING,
        basePointsPreMultiplierScaled6: ZERO_POINTS_SCALED6,
        totalProjectedScore: ZERO_POINTS_SCALED6,
      },
    };
  }

  const projectionBoostWeek = Math.min(weekNumber, getWeekRange().endWeek);

  const [steeringSnapshot, streakSnapshot, weeklyRewards] = await Promise.all([
    getSteeringSnapshot(wallet, weekNumber),
    getImpactStreakSnapshot({ walletAddress: wallet, weekNumber }),
    fetchWalletWeeklyRewards({
      walletAddress: wallet,
      paymentCurrency: "GLW",
      limit: 8,
      startWeek: weekNumber,
      endWeek: weekNumber,
    }).catch(async () => {
      const rewardsResult = await fetchWalletRewardsHistoryBatch({
        wallets: [wallet],
        startWeek: weekNumber,
        endWeek: weekNumber,
      }).catch(() => new Map<string, ControlApiFarmReward[]>());
      const rewards = rewardsResult.get(wallet) || [];
      return rewards.map((r) => ({
        weekNumber: Number(r.weekNumber),
        paymentCurrency: "GLW",
        protocolDepositRewardsReceived: "0",
        glowInflationTotal: r.walletTotalGlowInflationReward || "0",
      }));
    }),
  ]);

  const {
    steeredGlwWeiPerWeek,
    hasSteeringStake,
  } = steeringSnapshot;
  const {
    impactStreakWeeks,
    streakAsOfPreviousWeek,
    hasImpactActionThisWeek,
    hasMinerMultiplier,
    baseMultiplier,
    streakBonusMultiplier,
    totalMultiplierScaled6,
    totalMultiplier,
  } = streakSnapshot;

  let steeringBoostScaled6 = MULTIPLIER_SCALE_SCALED6;
  if (steeredGlwWeiPerWeek > 0n) {
    const steeringBoostByWeek = await getSteeringBoostByWeek({
      startWeek: projectionBoostWeek,
      endWeek: projectionBoostWeek,
      foundationWallets: EXCLUDED_LEADERBOARD_WALLETS,
    });
    steeringBoostScaled6 =
      steeringBoostByWeek.get(projectionBoostWeek) ?? MULTIPLIER_SCALE_SCALED6;
  }

  const delegatedGlwWei = BigInt(glowWorth?.delegatedActiveGlwWei || "0");
  const glowWorthWei = BigInt(glowWorth?.glowWorthWei || "0");

  // Extract inflation from weekly rewards result
  let inflationGlwWei = BigInt(0);
  for (const row of weeklyRewards) {
    if (Number(row.weekNumber) !== weekNumber) continue;
    inflationGlwWei += safeBigInt(row.glowInflationTotal);
  }

  const inflationPts = glwWeiToPointsScaled6(
    inflationGlwWei,
    INFLATION_POINTS_PER_GLW_SCALED6
  );
  let steeringPts = glwWeiToPointsScaled6(
    steeredGlwWeiPerWeek,
    STEERING_POINTS_PER_GLW_SCALED6
  );
  if (steeringBoostScaled6 !== MULTIPLIER_SCALE_SCALED6) {
    steeringPts = applyMultiplierScaled6({
      pointsScaled6: steeringPts,
      multiplierScaled6: steeringBoostScaled6,
    });
  }
  const vaultPts = glwWeiToPointsScaled6(
    delegatedGlwWei,
    VAULT_BONUS_POINTS_PER_GLW_SCALED6
  );
  const rolloverPre = addScaled6Points([inflationPts, steeringPts, vaultPts]);
  const rollover = applyMultiplierScaled6({
    pointsScaled6: rolloverPre,
    multiplierScaled6: totalMultiplierScaled6,
  });
  const continuousPts = glwWeiToPointsScaled6(
    glowWorthWei,
    GLOW_WORTH_POINTS_PER_GLW_SCALED6
  );
  const basePointsPreMultiplierScaled6 = rolloverPre + continuousPts;
  const continuousPtsMultiplied = applyMultiplierScaled6({
    pointsScaled6: continuousPts,
    multiplierScaled6: totalMultiplierScaled6,
  });
  const totalProjectedScore = rollover + continuousPtsMultiplied;

  return {
    weekNumber,
    hasMinerMultiplier,
    hasSteeringStake,
    impactStreakWeeks,
    streakAsOfPreviousWeek,
    hasImpactActionThisWeek,
    baseMultiplier,
    streakBonusMultiplier,
    totalMultiplier,
    projectedPoints: {
      steeringGlwWei: steeredGlwWeiPerWeek.toString(),
      inflationGlwWei: inflationGlwWei.toString(),
      delegatedGlwWei: delegatedGlwWei.toString(),
      glowWorthWei: glowWorthWei.toString(),
      basePointsPreMultiplierScaled6: formatPointsScaled6(
        basePointsPreMultiplierScaled6
      ),
      totalProjectedScore: formatPointsScaled6(totalProjectedScore),
    },
  };
}
