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
  getUnclaimedGlwRewardsWei,
  type ControlApiFarmReward,
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
}

export interface GlowImpactScoreResult {
  walletAddress: string;
  weekRange: { startWeek: number; endWeek: number };
  glowWorth: GlowWorthResult;
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
  weekly: WeeklyImpactRow[];
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

  const startTimestamp = GENESIS_TIMESTAMP + startWeek * 604800;
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
    if (week < startWeek || week > endWeek) continue;
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
    if (week < startWeek || week > endWeek) continue;
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
  const steeringByWallet = new Map<
    string,
    { byWeek: Map<number, bigint>; dataSource: "control-api" }
  >();

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
    const steering = steeringByWallet.get(wallet) || {
      byWeek: new Map<number, bigint>(),
      dataSource: "mock" as const,
    };

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

    const weekly: WeeklyImpactRow[] = [];

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
      const multiplier = hasCashMinerBonus ? 3 : 1;
      const rollover = rolloverPre * BigInt(multiplier);

      const glowWorthWeekWei =
        liquidGlwWei + delegatedActive + unclaimed.amountWei;
      const continuousPts = glwWeiToPointsScaled6(
        glowWorthWeekWei,
        GLOW_WORTH_POINTS_PER_GLW_SCALED6
      );

      const totalWeekPts = rollover + continuousPts;

      totalPointsScaled6 += totalWeekPts;
      rolloverPointsScaled6 += rollover;
      continuousPointsScaled6 += continuousPts;
      inflationPointsScaled6 += inflationPts;
      steeringPointsScaled6 += steeringPts;
      vaultBonusPointsScaled6 += vaultPts;

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
          rolloverMultiplier: multiplier,
          rolloverPoints: formatPointsScaled6(rollover),
          glowWorthGlwWei: glowWorthWeekWei.toString(),
          continuousPoints: formatPointsScaled6(continuousPts),
          totalPoints: formatPointsScaled6(totalWeekPts),
          hasCashMinerBonus,
        });
      }
    }

    const delegatedActiveNow = clampToZero(
      delegatedCumulative - recoveredCumulative
    );
    const glowWorthNowWei =
      liquidGlwWei + delegatedActiveNow + unclaimed.amountWei;

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
      weekly,
    });
  }

  return results;
}
