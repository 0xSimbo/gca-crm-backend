import { and, eq, inArray, gte, lte } from "drizzle-orm";

import { db } from "../../../db/db";
import {
  fractionRefunds,
  fractionSplits,
  fractions,
  applications,
  RewardSplits,
} from "../../../db/schema";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getLiquidGlwBalanceWei } from "./glw-balance";
import {
  fetchDepositSplitsHistoryBatch,
  fetchFarmRewardsHistoryBatch,
  fetchWalletRewardsHistoryBatch,
  fetchGlwHoldersFromPonder,
  fetchGlwTwabByWeekWeiMany,
  fetchGctlStakersFromControlApi,
  fetchClaimedPdWeeksBatch,
  getGctlSteeringByWeekWei,
  getSteeringSnapshot,
  getUnclaimedGlwRewardsWei,
  type ControlApiFarmReward,
  type ControlApiDepositSplitHistorySegment,
  type ControlApiFarmRewardsHistoryRewardRow,
  type SteeringByWeekResult,
} from "./control-api";
import {
  addScaled6Points,
  clampToZero,
  formatPointsScaled6,
  glwWeiToPointsScaled6,
  GLW_DECIMALS,
} from "./points";

const BATCH_SIZE = 500;
const DELEGATION_START_WEEK = 97;

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
  unclaimedGlwRewardsWei: string;
  glowWorthWei: string;
  dataSources: {
    liquidGlw: "onchain";
    delegatedActiveGlw: "db+control-api";
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
}

export interface ImpactScoreComposition {
  steeringPoints: string;
  inflationPoints: string;
  worthPoints: string;
  vaultPoints: string;
}

export interface CurrentWeekProjection {
  weekNumber: number;
  hasMinerMultiplier: boolean;
  hasSteeringStake: boolean;
  impactStreakWeeks: number;
  baseMultiplier: number;
  streakBonusMultiplier: number;
  totalMultiplier: number;
  projectedPoints: {
    steeringGlwWei: string;
    inflationGlwWei: string;
    delegatedGlwWei: string;
    glowWorthWei: string;
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
  totals: {
    totalPoints: string;
    rolloverPoints: string;
    continuousPoints: string;
    inflationPoints: string;
    steeringPoints: string;
    vaultBonusPoints: string;
    totalInflationGlwWei: string;
    totalSteeringGlwWei: string;
  };
  composition: ImpactScoreComposition;
  lastWeekPoints: string;
  activeMultiplier: boolean;
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

export async function getImpactLeaderboardWalletUniverse(params: {
  limit: number;
  debug?: ImpactTimingCollector;
}): Promise<{
  eligibleWallets: string[];
  candidateWallets: string[];
}> {
  const limit = Math.max(params.limit, 1);

  const { debug } = params;
  const [protocolWallets, glwHolders, gctlStakers] = await Promise.all([
    timePromise(debug, "universe.protocolWallets", getAllImpactWallets()),
    timePromise(debug, "universe.glwHolders", fetchGlwHoldersFromPonder()),
    timePromise(
      debug,
      "universe.gctlStakers",
      fetchGctlStakersFromControlApi()
    ),
  ]);

  const eligibleSet = new Set<string>();
  for (const w of protocolWallets) eligibleSet.add(w.toLowerCase());
  for (const w of glwHolders.holders) eligibleSet.add(w.toLowerCase());
  for (const w of gctlStakers.stakers) eligibleSet.add(w.toLowerCase());

  const poolSize = Math.max(limit * 3, 600);
  const topHolders = glwHolders.topHoldersByBalance.slice(0, poolSize);

  const candidateSet = new Set<string>();
  for (const w of protocolWallets) candidateSet.add(w.toLowerCase());
  for (const w of gctlStakers.stakers) candidateSet.add(w.toLowerCase());
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
      gctlStakers: gctlStakers.stakers.length,
    },
  });

  return {
    eligibleWallets: Array.from(eligibleSet),
    candidateWallets: Array.from(candidateSet),
  };
}

export async function computeGlowImpactScores(params: {
  walletAddresses: string[];
  startWeek: number;
  endWeek: number;
  includeWeeklyBreakdown: boolean;
  debug?: ImpactTimingCollector;
}): Promise<GlowImpactScoreResult[]> {
  const { walletAddresses, startWeek, endWeek, includeWeeklyBreakdown, debug } =
    params;
  const overallStart = nowMs();

  const wallets = walletAddresses
    .map((w) => w.toLowerCase())
    .filter((w, idx, arr) => arr.indexOf(w) === idx);

  if (wallets.length === 0) return [];
  const isSingleWalletQuery = wallets.length === 1;

  // Note: We intentionally do NOT convert non-GLW protocol deposit payouts to GLW
  // for `delegatedActiveGlwWei`. Only GLW-denominated protocol-deposit payouts count.

  // Liquid GLW TWAB per wallet/week (anti-gaming): computed from indexed ERC20 Transfer history.
  // If the downstream service is unavailable, we fall back to using the current onchain balance
  // (which reintroduces the "flash transfer" vector).
  let liquidTwabByWalletWeek = new Map<string, Map<number, bigint>>();
  const twabStart = nowMs();
  try {
    liquidTwabByWalletWeek = await fetchGlwTwabByWeekWeiMany({
      wallets,
      startWeek,
      endWeek,
    });
  } catch (e) {
    console.error(
      `[impact-score] TWAB fetch failed (wallets=${wallets.length}, startWeek=${startWeek}, endWeek=${endWeek})`,
      e
    );
    liquidTwabByWalletWeek = new Map();
  }
  recordTimingSafe(debug, {
    label: "compute.twab",
    ms: nowMs() - twabStart,
    meta: { wallets: wallets.length, startWeek, endWeek },
  });

  // Fetch Control API rewards for all wallets (batch)
  // We may need history earlier than `startWeek` to seed delegatedActive from the week
  // delegations started (week 97), since recoveries can occur later.
  const rewardsFetchStartWeek = Math.min(startWeek, DELEGATION_START_WEEK);
  const walletRewardsMap = new Map<string, ControlApiFarmReward[]>();
  const walletRewardsStart = nowMs();
  let walletRewardsBatches = 0;
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const batchStart = nowMs();
    const batchMap = await fetchWalletRewardsHistoryBatch({
      wallets: batch,
      startWeek: rewardsFetchStartWeek,
      endWeek,
    });
    walletRewardsBatches++;
    recordTimingSafe(debug, {
      label: "compute.walletRewards.batch",
      ms: nowMs() - batchStart,
      meta: {
        batchSize: batch.length,
        startWeek: rewardsFetchStartWeek,
        endWeek,
      },
    });
    for (const [wallet, rewards] of batchMap)
      walletRewardsMap.set(wallet, rewards);
  }
  recordTimingSafe(debug, {
    label: "compute.walletRewards.total",
    ms: nowMs() - walletRewardsStart,
    meta: { wallets: wallets.length, batches: walletRewardsBatches },
  });

  const streakSeedStartWeek = Math.max(startWeek - STREAK_BONUS_CAP_WEEKS, 0);
  const miningPurchaseWeeksByWallet = new Map<string, Set<number>>();

  // Mining-center purchases only affect the cash-miner multiplier + streak eligibility (not vault ownership).
  // PD splits for mining center are always zero.
  const miningStartTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const miningEndTimestamp = GENESIS_TIMESTAMP + (endWeek + 1) * 604800 - 1;
  const miningQueryStart = nowMs();
  const miningRows = await db
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
  recordTimingSafe(debug, {
    label: "compute.db.miningRows",
    ms: nowMs() - miningQueryStart,
    meta: { rows: miningRows.length, wallets: wallets.length },
  });

  for (const row of miningRows) {
    const wallet = row.buyer.toLowerCase();
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > endWeek) continue;
    if (!miningPurchaseWeeksByWallet.has(wallet))
      miningPurchaseWeeksByWallet.set(wallet, new Set());
    miningPurchaseWeeksByWallet.get(wallet)!.add(week);
  }

  // Vault model inputs:
  // - deposit split ownership history (raw 6-decimal ints) from Control API
  // - farm principal (GLW-paid applications) from DB
  // - farm weekly distributed PD amounts from Control API (to compute remaining principal)
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
      label: "compute.depositSplits.batch",
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
    label: "compute.depositSplits.total",
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
    const principalQueryStart = nowMs();
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
      label: "compute.db.principalRows",
      ms: nowMs() - principalQueryStart,
      meta: { rows: principalRows.length, farms: farmIds.length },
    });
    for (const row of principalRows) {
      if (!row.farmId) continue;
      const amountWei = safeBigInt(row.paymentAmount);
      if (amountWei <= BigInt(0)) continue;
      principalByFarm.set(
        row.farmId,
        (principalByFarm.get(row.farmId) || BigInt(0)) + amountWei
      );
    }
  }

  const glwPrincipalFarmIds = farmIds.filter(
    (id) => (principalByFarm.get(id) || BigInt(0)) > BigInt(0)
  );

  const farmDistributedTimelineByFarm = new Map<
    string,
    FarmDistributionTimelinePoint[]
  >();
  const farmRewardsStart = nowMs();
  let farmRewardsBatches = 0;
  for (const farmIdBatch of chunkArray(glwPrincipalFarmIds, 100)) {
    const batchStart = nowMs();
    const m = await fetchFarmRewardsHistoryBatch({
      farmIds: farmIdBatch,
      startWeek: DELEGATION_START_WEEK,
      endWeek,
    });
    farmRewardsBatches++;
    recordTimingSafe(debug, {
      label: "compute.farmRewards.batch",
      ms: nowMs() - batchStart,
      meta: {
        batchSize: farmIdBatch.length,
        startWeek: DELEGATION_START_WEEK,
        endWeek,
      },
    });
    for (const [farmId, rows] of m)
      farmDistributedTimelineByFarm.set(
        farmId,
        buildFarmCumulativeDistributedTimeline({ rows })
      );
  }
  recordTimingSafe(debug, {
    label: "compute.farmRewards.total",
    ms: nowMs() - farmRewardsStart,
    meta: { farms: glwPrincipalFarmIds.length, batches: farmRewardsBatches },
  });

  // Fetch onchain liquid balances + mock unclaimed rewards and steering (per wallet).
  const liquidByWallet = new Map<string, bigint>();
  const unclaimedByWallet = new Map<
    string,
    { amountWei: bigint; dataSource: "claims-api+control-api" }
  >();
  const steeringByWallet = new Map<string, SteeringByWeekResult>();

  // In leaderboard/list mode, unclaimed rewards are the biggest bottleneck if fetched per-wallet.
  // We can compute "lite" unclaimed amounts locally from the already-fetched `walletRewardsMap`,
  // and only need a batched lookup for RewardsKernel PD claimed weeks.
  if (!isSingleWalletQuery) {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentEpoch = getCurrentEpoch(nowSec);
    const claimableThresholdWeek = Math.min(currentEpoch - 3, currentEpoch - 4);
    const claimableEndWeek = Math.min(endWeek, claimableThresholdWeek);
    const claimableStartWeek = startWeek;

    if (claimableEndWeek >= claimableStartWeek) {
      const claimsStart = nowMs();
      const claimedPdWeeksByWallet = await fetchClaimedPdWeeksBatch({
        wallets,
        startWeek: claimableStartWeek,
        endWeek: claimableEndWeek,
      });
      recordTimingSafe(debug, {
        label: "compute.claimsPdWeeks.batch",
        ms: nowMs() - claimsStart,
        meta: {
          wallets: wallets.length,
          startWeek: claimableStartWeek,
          endWeek: claimableEndWeek,
        },
      });

      for (const wallet of wallets) {
        const rewards = walletRewardsMap.get(wallet) || [];
        const inflationByWeek = new Map<number, bigint>();
        const pdByWeek = new Map<number, bigint>();
        let maxWeek = -1;

        for (const r of rewards) {
          const week = Number(r.weekNumber);
          if (!Number.isFinite(week)) continue;
          maxWeek = week > maxWeek ? week : maxWeek;

          if (week < claimableStartWeek || week > claimableEndWeek) continue;

          const inflation = safeBigInt(r.walletTotalGlowInflationReward);
          if (inflation > 0n)
            inflationByWeek.set(
              week,
              (inflationByWeek.get(week) || 0n) + inflation
            );

          const pdRaw = safeBigInt(r.walletProtocolDepositFromLaunchpad);
          const recoveredGlw = protocolDepositReceivedGlwWei({
            amountRaw: pdRaw,
            asset: r.asset,
          });
          if (recoveredGlw > 0n)
            pdByWeek.set(week, (pdByWeek.get(week) || 0n) + recoveredGlw);
        }

        const effectiveEndWeek = Math.min(claimableEndWeek, maxWeek);
        if (effectiveEndWeek < claimableStartWeek) {
          unclaimedByWallet.set(wallet, {
            amountWei: 0n,
            dataSource: "claims-api+control-api",
          });
          continue;
        }

        const claimedPdWeeks =
          claimedPdWeeksByWallet.get(wallet) || new Set<number>();

        let unclaimedWei = 0n;
        for (let w = claimableStartWeek; w <= effectiveEndWeek; w++) {
          const inflationWei = inflationByWeek.get(w) || 0n;
          const pdWei = pdByWeek.get(w) || 0n;

          // Lite mode: we do not infer MinerPool claim weeks, so inflation is treated as unclaimed.
          if (inflationWei > 0n) unclaimedWei += inflationWei;
          if (pdWei > 0n && !claimedPdWeeks.has(w)) unclaimedWei += pdWei;
        }

        unclaimedByWallet.set(wallet, {
          amountWei: unclaimedWei > 0n ? unclaimedWei : 0n,
          dataSource: "claims-api+control-api",
        });
      }
    } else {
      for (const wallet of wallets) {
        unclaimedByWallet.set(wallet, {
          amountWei: 0n,
          dataSource: "claims-api+control-api",
        });
      }
    }
  }

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

        try {
          const liquidStart = nowMs();
          const liquid = isHexWallet(wallet)
            ? await getLiquidGlwBalanceWei(wallet)
            : BigInt(0);
          liquidMs = nowMs() - liquidStart;

          const unclaimedStart = nowMs();
          const unclaimed = isSingleWalletQuery
            ? await getUnclaimedGlwRewardsWei(wallet, {
                mode: "accurate",
                startWeek,
                endWeek,
              })
            : unclaimedByWallet.get(wallet) || {
                amountWei: 0n,
                dataSource: "claims-api+control-api" as const,
              };
          unclaimedMs = nowMs() - unclaimedStart;

          const steeringStart = nowMs();
          const steering = await getGctlSteeringByWeekWei({
            walletAddress: wallet,
            startWeek,
            endWeek,
          }).catch((error) => {
            console.error(
              `[impact-score] steering fetch failed for wallet=${wallet}`,
              error
            );
            return getSteeringFallback({ startWeek, endWeek, error });
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

  const results: GlowImpactScoreResult[] = [];

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
      { split: SegmentState; principalWei: bigint; dist: TimelineState }
    >();
    for (const [farmId, segs] of splitSegmentsByFarm) {
      const principalWei = principalByFarm.get(farmId) || BigInt(0);
      if (principalWei <= BigInt(0)) continue;
      const timeline = farmDistributedTimelineByFarm.get(farmId) || [];
      farmStates.set(farmId, {
        split: makeSegmentState(segs),
        principalWei,
        dist: makeTimelineState(timeline),
      });
    }

    let totalPointsScaled6 = BigInt(0);
    let rolloverPointsScaled6 = BigInt(0);
    let continuousPointsScaled6 = BigInt(0);
    let inflationPointsScaled6 = BigInt(0);
    let steeringPointsScaled6 = BigInt(0);
    let vaultBonusPointsScaled6 = BigInt(0);
    let totalInflationGlwWei = BigInt(0);
    let totalSteeringGlwWei = BigInt(0);

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
    for (let week = startWeek; week <= endWeek; week++) {
      let delegatedActive = BigInt(0);
      let grossShareWei = BigInt(0);
      for (const farm of farmStates.values()) {
        const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
        if (splitScaled6 <= BigInt(0)) continue;
        grossShareWei +=
          (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;

        const cumulativeDistributed = getCumulativeDistributedGlwWeiAtWeek(
          farm.dist,
          week
        );
        const remaining = clampToZero(
          farm.principalWei - cumulativeDistributed
        );
        delegatedActive += (remaining * splitScaled6) / SPLIT_SCALE_SCALED6;
      }
      if (week === endWeek) delegatedActiveNow = delegatedActive;
      const inflationGlwWei = inflationByWeek.get(week) || BigInt(0);
      const steeringGlwWei = steering.byWeek.get(week) || BigInt(0);

      totalInflationGlwWei += inflationGlwWei;
      totalSteeringGlwWei += steeringGlwWei;

      const inflationPts = glwWeiToPointsScaled6(
        inflationGlwWei,
        INFLATION_POINTS_PER_GLW_SCALED6
      );
      const steeringPts = glwWeiToPointsScaled6(
        steeringGlwWei,
        STEERING_POINTS_PER_GLW_SCALED6
      );
      const vaultPts = glwWeiToPointsScaled6(
        delegatedActive,
        VAULT_BONUS_POINTS_PER_GLW_SCALED6
      );

      const rolloverPre = addScaled6Points([
        inflationPts,
        steeringPts,
        vaultPts,
      ]);
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

      const liquidTwabWeekWei =
        liquidTwabByWalletWeek.get(wallet)?.get(week) ?? liquidGlwWei;
      const glowWorthWeekWei =
        liquidTwabWeekWei + delegatedActive + unclaimed.amountWei;
      const continuousPts = glwWeiToPointsScaled6(
        glowWorthWeekWei,
        GLOW_WORTH_POINTS_PER_GLW_SCALED6
      );

      const totalWeekPts = rollover + continuousPts;

      // Composition (make sure it sums to total points, including multiplier effects)
      compositionInflationScaled6 += applyMultiplierScaled6({
        pointsScaled6: inflationPts,
        multiplierScaled6: totalMultiplierScaled6,
      });
      compositionSteeringScaled6 += applyMultiplierScaled6({
        pointsScaled6: steeringPts,
        multiplierScaled6: totalMultiplierScaled6,
      });
      compositionVaultScaled6 += applyMultiplierScaled6({
        pointsScaled6: vaultPts,
        multiplierScaled6: totalMultiplierScaled6,
      });
      compositionWorthScaled6 += continuousPts;

      totalPointsScaled6 += totalWeekPts;
      rolloverPointsScaled6 += rollover;
      continuousPointsScaled6 += continuousPts;
      inflationPointsScaled6 += inflationPts;
      steeringPointsScaled6 += steeringPts;
      vaultBonusPointsScaled6 += vaultPts;

      if (week === lastWeek && lastWeek >= startWeek) {
        // `lastWeekPoints` is intended to represent the isolated points earned
        // in the last completed week (velocity), not the cumulative total.
        lastWeekPointsScaled6 = totalWeekPts;
      }

      if (week === endWeek) endWeekMultiplier = rolloverMultiplier;

      if (includeWeeklyBreakdown) {
        weekly.push({
          weekNumber: week,
          inflationGlwWei: inflationGlwWei.toString(),
          steeringGlwWei: steeringGlwWei.toString(),
          delegatedActiveGlwWei: delegatedActive.toString(),
          protocolDepositRecoveredGlwWei: (
            protocolRecoveredByWeek.get(week) || BigInt(0)
          ).toString(),
          inflationPoints: formatPointsScaled6(inflationPts),
          steeringPoints: formatPointsScaled6(steeringPts),
          vaultBonusPoints: formatPointsScaled6(vaultPts),
          rolloverPointsPreMultiplier: formatPointsScaled6(rolloverPre),
          rolloverMultiplier,
          rolloverPoints: formatPointsScaled6(rollover),
          glowWorthGlwWei: glowWorthWeekWei.toString(),
          continuousPoints: formatPointsScaled6(continuousPts),
          totalPoints: formatPointsScaled6(totalWeekPts),
          hasCashMinerBonus,
          baseMultiplier,
          streakBonusMultiplier,
          impactStreakWeeks,
        });
      }
    }

    const glowWorthNowWei =
      liquidGlwWei + delegatedActiveNow + unclaimed.amountWei;

    const effectiveLastWeekPoints =
      lastWeek >= startWeek ? lastWeekPointsScaled6 : BigInt(0);
    const activeMultiplier = endWeekMultiplier > 1;

    results.push({
      walletAddress: wallet,
      weekRange: { startWeek, endWeek },
      glowWorth: {
        walletAddress: wallet,
        liquidGlwWei: liquidGlwWei.toString(),
        delegatedActiveGlwWei: delegatedActiveNow.toString(),
        unclaimedGlwRewardsWei: unclaimed.amountWei.toString(),
        glowWorthWei: glowWorthNowWei.toString(),
        dataSources: {
          liquidGlw: "onchain",
          delegatedActiveGlw: "db+control-api",
          unclaimedGlwRewards: unclaimed.dataSource,
        },
      },
      ...(steering.isFallback
        ? { warnings: { steering: steering.error || "Steering fallback used" } }
        : {}),
      totals: {
        totalPoints: formatPointsScaled6(totalPointsScaled6),
        rolloverPoints: formatPointsScaled6(rolloverPointsScaled6),
        continuousPoints: formatPointsScaled6(continuousPointsScaled6),
        inflationPoints: formatPointsScaled6(inflationPointsScaled6),
        steeringPoints: formatPointsScaled6(steeringPointsScaled6),
        vaultBonusPoints: formatPointsScaled6(vaultBonusPointsScaled6),
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
      endWeekMultiplier,
      weekly,
    });
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

  recordTimingSafe(debug, {
    label: "compute.total",
    ms: nowMs() - overallStart,
    meta: {
      wallets: wallets.length,
      startWeek,
      endWeek,
      includeWeeklyBreakdown,
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

  // Miner purchases only affect multiplier + streak eligibility.
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
      startWeek: DELEGATION_START_WEEK,
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
  let previousGrossShareWei = BigInt(0);
  for (let week = streakSeedStartWeek; week <= weekNumber; week++) {
    let grossShareWei = BigInt(0);
    for (const farm of farmStates.values()) {
      const splitScaled6 = getSplitScaled6AtWeek(farm.split, week);
      if (splitScaled6 <= BigInt(0)) continue;
      grossShareWei += (farm.principalWei * splitScaled6) / SPLIT_SCALE_SCALED6;
    }

    const hasCashMinerBonus = cashMinerWeeks.has(week);
    const hasImpactActionThisWeek =
      grossShareWei > previousGrossShareWei || hasCashMinerBonus;
    impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
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

  const [
    { steeredGlwWeiPerWeek, hasSteeringStake },
    {
      impactStreakWeeks,
      hasMinerMultiplier,
      baseMultiplier,
      streakBonusMultiplier,
      totalMultiplierScaled6,
      totalMultiplier,
    },
  ] = await Promise.all([
    getSteeringSnapshot(wallet),
    getImpactStreakSnapshot({ walletAddress: wallet, weekNumber }),
  ]);

  const delegatedGlwWei = BigInt(glowWorth?.delegatedActiveGlwWei || "0");
  const glowWorthWei = BigInt(glowWorth?.glowWorthWei || "0");

  // Best-effort: if Control API exposes partial week accounting, use it; otherwise 0.
  let inflationGlwWei = BigInt(0);
  try {
    const rewardsMap = await fetchWalletRewardsHistoryBatch({
      wallets: [wallet],
      startWeek: weekNumber,
      endWeek: weekNumber,
    });
    const rewards = rewardsMap.get(wallet) || [];
    for (const r of rewards) {
      inflationGlwWei += BigInt(r.walletTotalGlowInflationReward || "0");
    }
  } catch {
    inflationGlwWei = BigInt(0);
  }

  const inflationPts = glwWeiToPointsScaled6(
    inflationGlwWei,
    INFLATION_POINTS_PER_GLW_SCALED6
  );
  const steeringPts = glwWeiToPointsScaled6(
    steeredGlwWeiPerWeek,
    STEERING_POINTS_PER_GLW_SCALED6
  );
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
  const totalProjectedScore = rollover + continuousPts;

  return {
    weekNumber,
    hasMinerMultiplier,
    hasSteeringStake,
    impactStreakWeeks,
    baseMultiplier,
    streakBonusMultiplier,
    totalMultiplier,
    projectedPoints: {
      steeringGlwWei: steeredGlwWeiPerWeek.toString(),
      inflationGlwWei: inflationGlwWei.toString(),
      delegatedGlwWei: delegatedGlwWei.toString(),
      glowWorthWei: glowWorthWei.toString(),
      totalProjectedScore: formatPointsScaled6(totalProjectedScore),
    },
  };
}
