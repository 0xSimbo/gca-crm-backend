import { and, eq, inArray, gte, lte } from "drizzle-orm";

import { db } from "../../../db/db";
import {
  fractionRefunds,
  fractionSplits,
  fractions,
  RewardSplits,
} from "../../../db/schema";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";
import { getCachedGlwSpotPriceNumber } from "../../../utils/glw-spot";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getLiquidGlwBalanceWei } from "./glw-balance";
import {
  fetchWalletRewardsHistoryBatch,
  getGctlSteeringByWeekWei,
  getSteeringSnapshot,
  getUnclaimedGlwRewardsWei,
  type ControlApiFarmReward,
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

const INFLATION_POINTS_PER_GLW_SCALED6 = BigInt(1_000_000); // +1.0 per GLW
const STEERING_POINTS_PER_GLW_SCALED6 = BigInt(3_000_000); // +3.0 per GLW
const VAULT_BONUS_POINTS_PER_GLW_SCALED6 = BigInt(5_000); // +0.005 per GLW per week
const GLOW_WORTH_POINTS_PER_GLW_SCALED6 = BigInt(1_000); // +0.001 per GLW per week

const MULTIPLIER_SCALE_SCALED6 = BigInt(1_000_000);
const BASE_STANDARD_MULTIPLIER_SCALED6 = BigInt(1_000_000); // 1.0x
const BASE_CASH_MINER_MULTIPLIER_SCALED6 = BigInt(3_000_000); // 3.0x
const STREAK_BONUS_PER_WEEK_SCALED6 = BigInt(250_000); // +0.25x
const STREAK_BONUS_CAP_WEEKS = 4;

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

function getStableDecimals(asset: string | null | undefined): number {
  // Control API returns protocol deposit payouts in asset native decimals.
  // For now we assume stablecoins use 6 decimals.
  if (!asset) return 6;
  const upper = asset.toUpperCase();
  if (upper === "USDC" || upper === "USDG") return 6;
  return 6;
}

function isGlwAsset(asset: string | null | undefined): boolean {
  return (asset || "").toUpperCase() === "GLW";
}

function convertProtocolDepositToGlwWei(params: {
  amountRaw: bigint;
  asset: string | null | undefined;
  glwSpotPriceUsd: number;
}): bigint {
  const { amountRaw, asset, glwSpotPriceUsd } = params;
  if (amountRaw <= BigInt(0)) return BigInt(0);
  if (isGlwAsset(asset)) return amountRaw;
  if (glwSpotPriceUsd <= 0) return BigInt(0);

  const stableDecimals = getStableDecimals(asset);
  const priceScaled6 = BigInt(Math.round(glwSpotPriceUsd * 1_000_000));
  if (priceScaled6 <= BigInt(0)) return BigInt(0);

  // stableRaw (6 decimals) -> GLW wei:
  // glw = stableUsd / priceUsdPerGlw
  // glwWei = stableRaw * 1e18 / (priceScaled6) / (10^stableDecimals / 1e6)
  // with stableDecimals=6, this is simply: stableRaw * 1e18 / priceScaled6
  if (stableDecimals === 6) {
    return (amountRaw * GLW_DECIMALS) / priceScaled6;
  }

  const stableDecimalsFactor = BigInt(10) ** BigInt(stableDecimals);
  const stableScaled6 = (amountRaw * BigInt(1_000_000)) / stableDecimalsFactor;
  return (stableScaled6 * GLW_DECIMALS) / priceScaled6;
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

export async function computeGlowImpactScores(params: {
  walletAddresses: string[];
  startWeek: number;
  endWeek: number;
  includeWeeklyBreakdown: boolean;
}): Promise<GlowImpactScoreResult[]> {
  const { walletAddresses, startWeek, endWeek, includeWeeklyBreakdown } =
    params;

  const wallets = walletAddresses
    .map((w) => w.toLowerCase())
    .filter((w, idx, arr) => arr.indexOf(w) === idx);

  if (wallets.length === 0) return [];

  const glwSpotPriceUsd = await getCachedGlwSpotPriceNumber();

  // Fetch Control API rewards for all wallets (batch)
  const walletRewardsMap = new Map<string, ControlApiFarmReward[]>();
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const batchMap = await fetchWalletRewardsHistoryBatch({
      wallets: batch,
      startWeek,
      endWeek,
    });
    for (const [wallet, rewards] of batchMap)
      walletRewardsMap.set(wallet, rewards);
  }

  const streakSeedStartWeek = Math.max(startWeek - STREAK_BONUS_CAP_WEEKS, 0);
  const startTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const endTimestamp = GENESIS_TIMESTAMP + (endWeek + 1) * 604800 - 1;

  const splitRows = await db
    .select({
      buyer: fractionSplits.buyer,
      amount: fractionSplits.amount,
      timestamp: fractionSplits.timestamp,
      fractionType: fractions.type,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionSplits.buyer, wallets),
        gte(fractionSplits.timestamp, startTimestamp),
        lte(fractionSplits.timestamp, endTimestamp)
      )
    );

  const refundRows = await db
    .select({
      user: fractionRefunds.user,
      amount: fractionRefunds.amount,
      timestamp: fractionRefunds.timestamp,
      fractionType: fractions.type,
    })
    .from(fractionRefunds)
    .innerJoin(fractions, eq(fractionRefunds.fractionId, fractions.id))
    .where(
      and(
        inArray(fractionRefunds.user, wallets),
        gte(fractionRefunds.timestamp, startTimestamp),
        lte(fractionRefunds.timestamp, endTimestamp)
      )
    );

  const delegationDeltasByWalletWeek = new Map<string, Map<number, bigint>>();
  const miningPurchaseWeeksByWallet = new Map<string, Set<number>>();

  function addDelta(wallet: string, week: number, delta: bigint) {
    if (!delegationDeltasByWalletWeek.has(wallet)) {
      delegationDeltasByWalletWeek.set(wallet, new Map());
    }
    const map = delegationDeltasByWalletWeek.get(wallet)!;
    map.set(week, (map.get(week) || BigInt(0)) + delta);
  }

  for (const row of splitRows) {
    const wallet = row.buyer.toLowerCase();
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > endWeek) continue;
    const amount = BigInt(row.amount);
    if (row.fractionType === "launchpad") {
      addDelta(wallet, week, amount);
    }
    if (row.fractionType === "mining-center") {
      if (!miningPurchaseWeeksByWallet.has(wallet)) {
        miningPurchaseWeeksByWallet.set(wallet, new Set());
      }
      miningPurchaseWeeksByWallet.get(wallet)!.add(week);
    }
  }

  for (const row of refundRows) {
    const wallet = row.user.toLowerCase();
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > endWeek) continue;
    const amount = BigInt(row.amount);
    if (row.fractionType === "launchpad") {
      addDelta(wallet, week, -amount);
    }
  }

  // Fetch onchain liquid balances + mock unclaimed rewards and steering (per wallet).
  const liquidByWallet = new Map<string, bigint>();
  const unclaimedByWallet = new Map<
    string,
    { amountWei: bigint; dataSource: "claims-api+control-api" }
  >();
  const steeringByWallet = new Map<string, SteeringByWeekResult>();

  const concurrency = 8;
  for (let i = 0; i < wallets.length; i += concurrency) {
    const batch = wallets.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (wallet) => {
        const liquid = isHexWallet(wallet)
          ? await getLiquidGlwBalanceWei(wallet)
          : BigInt(0);
        const unclaimed = await getUnclaimedGlwRewardsWei(wallet);
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
        return { wallet, liquid, unclaimed, steering };
      })
    );
    for (const r of settled) {
      if (r.status !== "fulfilled") {
        console.error(
          "[impact-score] Failed to fetch wallet inputs:",
          r.reason
        );
        continue;
      }
      liquidByWallet.set(r.value.wallet, r.value.liquid);
      unclaimedByWallet.set(r.value.wallet, r.value.unclaimed);
      steeringByWallet.set(r.value.wallet, r.value.steering);
    }
  }

  const results: GlowImpactScoreResult[] = [];

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
      const recoveredGlw = convertProtocolDepositToGlwWei({
        amountRaw: pdRaw,
        asset: r.asset,
        glwSpotPriceUsd,
      });
      protocolRecoveredByWeek.set(
        week,
        (protocolRecoveredByWeek.get(week) || BigInt(0)) + recoveredGlw
      );
    }

    const delegationDeltas =
      delegationDeltasByWalletWeek.get(wallet) || new Map();
    const cashMinerWeeks = miningPurchaseWeeksByWallet.get(wallet) || new Set();

    let delegatedCumulative = BigInt(0);
    let recoveredCumulative = BigInt(0);

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
    for (let week = streakSeedStartWeek; week < startWeek; week++) {
      const hasCashMinerBonus = cashMinerWeeks.has(week);
      const hasDelegationIncreaseThisWeek =
        (delegationDeltas.get(week) || BigInt(0)) > BigInt(0);
      const hasImpactActionThisWeek =
        hasDelegationIncreaseThisWeek || hasCashMinerBonus;
      impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
    }

    const weekly: WeeklyImpactRow[] = [];
    let endWeekMultiplier = 1;

    for (let week = startWeek; week <= endWeek; week++) {
      delegatedCumulative += delegationDeltas.get(week) || BigInt(0);
      recoveredCumulative += protocolRecoveredByWeek.get(week) || BigInt(0);

      const delegatedActive = clampToZero(
        delegatedCumulative - recoveredCumulative
      );
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

      const hasDelegationIncreaseThisWeek =
        (delegationDeltas.get(week) || BigInt(0)) > BigInt(0);
      const hasImpactActionThisWeek =
        hasDelegationIncreaseThisWeek || hasCashMinerBonus;
      impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
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

      const glowWorthWeekWei =
        liquidGlwWei + delegatedActive + unclaimed.amountWei;
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

    const delegatedActiveNow = clampToZero(
      delegatedCumulative - recoveredCumulative
    );
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
  const startTimestamp = GENESIS_TIMESTAMP + streakSeedStartWeek * 604800;
  const now = Math.floor(Date.now() / 1000);

  const splitRows = await db
    .select({
      buyer: fractionSplits.buyer,
      amount: fractionSplits.amount,
      timestamp: fractionSplits.timestamp,
      fractionType: fractions.type,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        eq(fractionSplits.buyer, wallet),
        gte(fractionSplits.timestamp, startTimestamp),
        lte(fractionSplits.timestamp, now),
        inArray(fractions.type, ["launchpad", "mining-center"])
      )
    );

  const refundRows = await db
    .select({
      user: fractionRefunds.user,
      amount: fractionRefunds.amount,
      timestamp: fractionRefunds.timestamp,
      fractionType: fractions.type,
    })
    .from(fractionRefunds)
    .innerJoin(fractions, eq(fractionRefunds.fractionId, fractions.id))
    .where(
      and(
        eq(fractionRefunds.user, wallet),
        gte(fractionRefunds.timestamp, startTimestamp),
        lte(fractionRefunds.timestamp, now),
        eq(fractions.type, "launchpad")
      )
    );

  const delegationDeltasByWeek = new Map<number, bigint>();
  const cashMinerWeeks = new Set<number>();

  for (const row of splitRows) {
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > weekNumber) continue;
    const amount = BigInt(row.amount);
    if (row.fractionType === "launchpad") {
      delegationDeltasByWeek.set(
        week,
        (delegationDeltasByWeek.get(week) || BigInt(0)) + amount
      );
    }
    if (row.fractionType === "mining-center") cashMinerWeeks.add(week);
  }

  for (const row of refundRows) {
    const week = getCurrentEpoch(row.timestamp);
    if (week < streakSeedStartWeek || week > weekNumber) continue;
    const amount = BigInt(row.amount);
    delegationDeltasByWeek.set(
      week,
      (delegationDeltasByWeek.get(week) || BigInt(0)) - amount
    );
  }

  let impactStreakWeeks = 0;
  for (let week = streakSeedStartWeek; week <= weekNumber; week++) {
    const hasCashMinerBonus = cashMinerWeeks.has(week);
    const hasDelegationIncreaseThisWeek =
      (delegationDeltasByWeek.get(week) || BigInt(0)) > BigInt(0);
    const hasImpactActionThisWeek =
      hasDelegationIncreaseThisWeek || hasCashMinerBonus;
    impactStreakWeeks = hasImpactActionThisWeek ? impactStreakWeeks + 1 : 0;
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
