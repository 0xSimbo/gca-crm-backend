import { db } from "../../../db/db";
import { referrals, referralPointsWeekly, referralCodes } from "../../../db/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { GlowImpactScoreResult, type CurrentWeekProjection } from "./impact-score";
import { viemClient } from "../../../lib/web3-providers/viem-client";
import { formatPointsScaled6 } from "./points";
import { GENESIS_TIMESTAMP } from "../../../constants/genesis-timestamp";
import { dateToEpoch } from "../../../utils/getProtocolWeek";
import { excludedLeaderboardWalletsSet } from "../../../constants/excluded-wallets";

/**
 * Tiered referrer share based on active referral count.
 * Seed (1 ref): 5% | Grow (2-3): 10% | Scale (4-6): 15% | Legend (7+): 20%
 */
export const REFERRER_TIERS = [
  { minReferrals: 7, percent: 20n, name: "Legend" },
  { minReferrals: 4, percent: 15n, name: "Scale" },
  { minReferrals: 2, percent: 10n, name: "Grow" },
  { minReferrals: 1, percent: 5n, name: "Seed" },
] as const;

export const REFEREE_BONUS_PERCENT = 10n;
export const REFEREE_ACTIVATION_BONUS = 100_000000n; // 100 points (scaled6)
const ACTIVATION_THRESHOLD_SCALED6 = 100_000000n;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export function applyPostLinkProration(params: {
  basePointsScaled6: bigint;
  linkedAt: Date;
  weekNumber: number;
}): bigint {
  const weekStart = GENESIS_TIMESTAMP + params.weekNumber * WEEK_SECONDS;
  const weekEnd = weekStart + WEEK_SECONDS;
  const linkedAtSeconds = Math.floor(params.linkedAt.getTime() / 1000);
  if (linkedAtSeconds <= weekStart) return params.basePointsScaled6;
  if (linkedAtSeconds >= weekEnd) return 0n;
  const remaining = BigInt(weekEnd - linkedAtSeconds);
  return (params.basePointsScaled6 * remaining) / BigInt(WEEK_SECONDS);
}

function parseScaled6(val: string | undefined): bigint {
  if (!val) return 0n;
  const raw = val.trim();
  if (!raw) return 0n;
  const isNeg = raw.startsWith("-");
  const abs = isNeg ? raw.slice(1) : raw;
  const parts = abs.split(".");
  if (parts.length > 2) return 0n;
  const intPartRaw = parts[0] ?? "";
  const fracRaw = parts[1] ?? "";

  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  if (!/^\d+$/.test(intPart)) return 0n;
  if (fracRaw !== "" && !/^\d+$/.test(fracRaw)) return 0n;

  const frac = (fracRaw + "000000").slice(0, 6);
  let out = BigInt(intPart) * 1_000_000n + BigInt(frac);
  if (isNeg) out = -out;
  return out;
}

export function getReferrerTier(
  activeReferralCount: number,
  referrerBasePointsScaled6?: bigint
) {
  const eligible =
    referrerBasePointsScaled6 == null || referrerBasePointsScaled6 > 0n;
  const effectiveCount = eligible ? activeReferralCount : 0;

  for (const tier of REFERRER_TIERS) {
    if (effectiveCount >= tier.minReferrals) {
      const nextTierIndex = REFERRER_TIERS.indexOf(tier) - 1;
      const nextTier =
        nextTierIndex >= 0 ? REFERRER_TIERS[nextTierIndex] : undefined;
      return {
        percent: Number(tier.percent), // Convert to number for JSON
        name: tier.name as "Seed" | "Grow" | "Scale" | "Legend",
        nextTier: nextTier
          ? {
              name: nextTier.name,
              referralsNeeded: nextTier.minReferrals - effectiveCount,
              percent: Number(nextTier.percent),
            }
          : undefined,
      };
    }
  }
  return {
    percent: 0, // Convert to number for JSON
    name: "Seed" as any, // Start with Seed tier even if 0
    nextTier: {
      name: "Grow",
      referralsNeeded: 2 - effectiveCount,
      percent: 10,
    },
  };
}

export function calculateReferrerShare(
  refereeBasePointsScaled6: bigint,
  activeReferralCount: number,
  referrerBasePointsScaled6?: bigint
): bigint {
  const { percent } = getReferrerTier(
    activeReferralCount,
    referrerBasePointsScaled6
  );
  return (refereeBasePointsScaled6 * BigInt(percent)) / 100n;
}

export function calculateRefereeBonus(
  refereeBasePointsScaled6: bigint
): bigint {
  return (refereeBasePointsScaled6 * REFEREE_BONUS_PERCENT) / 100n;
}

export function calculateRefereeActivationBonus(): bigint {
  return REFEREE_ACTIVATION_BONUS;
}

export function combineRefereeBonusPointsScaled6(params: {
  referralBonusPointsScaled6: string | undefined;
  activationBonusPointsScaled6?: string | undefined;
  activationBonusAwarded: boolean;
}): string {
  const bonusPointsScaled6 = parseScaled6(params.referralBonusPointsScaled6);
  const activationFromTable = parseScaled6(params.activationBonusPointsScaled6);
  const activationBonusScaled6 =
    activationFromTable > 0n
      ? activationFromTable
      : params.activationBonusAwarded
      ? REFEREE_ACTIVATION_BONUS
      : 0n;
  return formatPointsScaled6(bonusPointsScaled6 + activationBonusScaled6);
}

/**
 * Check if a referral is within the 12-week bonus period for a given timestamp.
 */
export function isWithinBonusPeriod(params: {
  refereeBonusEndsAt: Date;
  weekEndTimestamp: number;
}): boolean {
  const weekEndMs = params.weekEndTimestamp * 1000;
  return weekEndMs <= params.refereeBonusEndsAt.getTime();
}

/**
 * Get total points earned by a referrer across all weeks and referees.
 */
export async function getReferrerStats(walletAddress: string, endWeek?: number) {
  const normalizedWallet = walletAddress.toLowerCase();

  // Run all queries in parallel
  const [pointsRes, thisWeekRes, activeCountRes] = await Promise.all([
    // 1. Lifetime Points
    db
      .select({
        totalPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
      })
      .from(referralPointsWeekly)
      .where(eq(referralPointsWeekly.referrerWallet, normalizedWallet)),
    // 2. This Week Points (skip if endWeek not provided)
    endWeek != null
      ? db
          .select({
            points: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
          })
          .from(referralPointsWeekly)
          .where(
            and(
              eq(referralPointsWeekly.referrerWallet, normalizedWallet),
              eq(referralPointsWeekly.weekNumber, endWeek)
            )
          )
      : Promise.resolve([{ points: "0.000000" }]),
    // 3. Active referee count
    db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(referrals)
      .where(
        and(
          eq(referrals.referrerWallet, normalizedWallet),
          eq(referrals.status, "active")
        )
      ),
  ]);

  return {
    totalPointsEarnedScaled6: pointsRes[0]?.totalPoints || "0.000000",
    thisWeekPointsScaled6: thisWeekRes[0]?.points || "0.000000",
    activeRefereeCount: activeCountRes[0]?.count || 0,
  };
}

export async function populateReferralData(
  results: GlowImpactScoreResult[],
  endWeek: number,
  currentWeekProjectionByWallet?: Map<string, CurrentWeekProjection>
) {
  const now = new Date();

  for (const r of results) {
    const wallet = r.walletAddress.toLowerCase();
    if (excludedLeaderboardWalletsSet.has(wallet)) {
      r.referral = {
        asReferrer: {
          totalPointsEarnedScaled6: "0.000000",
          thisWeekPointsScaled6: "0.000000",
          activeRefereeCount: 0,
          pendingRefereeCount: 0,
          currentTier: {
            name: "Seed",
            percent: 0,
          },
        },
      };
      r.composition.referralPoints = "0.000000";
      r.composition.referralBonusPoints = "0.000000";
      r.totals.totalPoints = formatPointsScaled6(0n);
      continue;
    }

    // 1. Run initial queries in parallel: referrer stats, pending count, and referral lookup
    const [stats, pendingCountRes, referral] = await Promise.all([
      getReferrerStats(wallet, endWeek),
      db
        .select({ count: sql<number>`count(*)` })
        .from(referrals)
        .where(and(eq(referrals.referrerWallet, wallet), eq(referrals.status, "pending"))),
      db.query.referrals.findFirst({
        where: eq(referrals.refereeWallet, wallet),
      }),
    ]);

    const referrerBasePointsScaled6 = parseScaled6(
      r.totals.basePointsPreMultiplierScaled6
    );
    const tier = getReferrerTier(
      stats.activeRefereeCount,
      referrerBasePointsScaled6
    );

    r.referral = {
      asReferrer: {
        totalPointsEarnedScaled6: stats.totalPointsEarnedScaled6,
        thisWeekPointsScaled6: stats.thisWeekPointsScaled6,
        activeRefereeCount: stats.activeRefereeCount,
        pendingRefereeCount: Number(pendingCountRes[0]?.count || 0),
        currentTier: {
          name: tier.name,
          percent: Number(tier.percent),
        },
        nextTier: tier.nextTier,
      },
    };

    // 2. As Referee - if referral exists, run all queries in parallel
    if (referral) {
      const activationStartWeek = dateToEpoch(referral.linkedAt);

      // Run all referee-related queries in parallel
      const [lifetimeBonusRes, basePointsRes, thisWeekRefRecord, referrerEns] = await Promise.all([
        db
          .select({
            referralBonusTotal: sql<string>`sum(referee_bonus_points_scaled6)`,
            activationBonusTotal: sql<string>`sum(activation_bonus_points_scaled6)`,
          })
          .from(referralPointsWeekly)
          .where(eq(referralPointsWeekly.refereeWallet, wallet)),
        db
          .select({
            total: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBasePointsScaled6}), '0.000000')`,
          })
          .from(referralPointsWeekly)
          .where(
            and(
              eq(referralPointsWeekly.refereeWallet, wallet),
              gte(referralPointsWeekly.weekNumber, activationStartWeek)
            )
          ),
        db.query.referralPointsWeekly.findFirst({
          where: and(
            eq(referralPointsWeekly.refereeWallet, wallet),
            eq(referralPointsWeekly.weekNumber, endWeek)
          ),
        }),
        viemClient.getEnsName({ address: referral.referrerWallet as `0x${string}` }).catch(() => null),
      ]);

      const historicalBasePointsScaled6 = parseScaled6(basePointsRes[0]?.total);
      const currentWeekProjection = currentWeekProjectionByWallet?.get(wallet);
      const projectedBasePointsRaw = parseScaled6(
        currentWeekProjection?.projectedPoints.basePointsPreMultiplierScaled6
      );
      const projectedBasePointsScaled6 = currentWeekProjection
        ? applyPostLinkProration({
            basePointsScaled6: projectedBasePointsRaw,
            linkedAt: referral.linkedAt,
            weekNumber: currentWeekProjection.weekNumber,
          })
        : 0n;
      const includeProjected =
        currentWeekProjection &&
        currentWeekProjection.weekNumber >= activationStartWeek;
      const postLinkBasePointsScaled6 =
        historicalBasePointsScaled6 +
        (includeProjected ? projectedBasePointsScaled6 : 0n);
      const activationPending =
        !referral.activationBonusAwarded &&
        includeProjected &&
        postLinkBasePointsScaled6 >= ACTIVATION_THRESHOLD_SCALED6;
      const projectedBonusPointsScaled6 =
        includeProjected && now < referral.refereeBonusEndsAt
          ? calculateRefereeBonus(projectedBasePointsScaled6)
          : 0n;

      const lifetimeBonusPointsScaled6 = combineRefereeBonusPointsScaled6({
        referralBonusPointsScaled6: lifetimeBonusRes[0]?.referralBonusTotal,
        activationBonusPointsScaled6: lifetimeBonusRes[0]?.activationBonusTotal,
        activationBonusAwarded: referral.activationBonusAwarded,
      });

      r.referral.asReferee = {
        referrerWallet: referral.referrerWallet,
        referrerEns: referrerEns || undefined,
        bonusIsActive: now < referral.refereeBonusEndsAt,
        bonusEndsAt: referral.refereeBonusEndsAt.toISOString(),
        bonusWeeksRemaining: Math.max(
          0,
          Math.ceil((referral.refereeBonusEndsAt.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000))
        ),
        bonusPointsThisWeekScaled6: thisWeekRefRecord?.refereeBonusPointsScaled6 || "0.000000",
        bonusPointsProjectedScaled6: formatPointsScaled6(projectedBonusPointsScaled6),
        lifetimeBonusPointsScaled6: lifetimeBonusPointsScaled6,
        activationBonus: {
          awarded: referral.activationBonusAwarded,
          awardedAt: referral.activationBonusAwardedAt?.toISOString(),
          pending: activationPending,
          pointsAwarded: 100,
        },
      };
    }

    // 3. Update Composition
    const refPoints = r.referral.asReferrer?.totalPointsEarnedScaled6 || "0.000000";
    const bonusPoints = r.referral.asReferee?.lifetimeBonusPointsScaled6 || "0.000000";

    const baseTotal = parseScaled6(r.totals.totalPoints);
    const refPointsScaled6 = parseScaled6(refPoints);
    const bonusPointsScaled6 = parseScaled6(bonusPoints);
    const combinedTotal = baseTotal + refPointsScaled6 + bonusPointsScaled6;

    r.totals.totalPoints = formatPointsScaled6(combinedTotal);
    r.composition.referralPoints = refPoints;
    r.composition.referralBonusPoints = bonusPoints;
  }
}
