import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import {
  referrals,
  referralCodes,
  referralFeatureLaunchSeen,
  referralPointsWeekly,
  impactLeaderboardCache,
} from "../../db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { TAG } from "../../constants";
import { getOrCreateReferralCode } from "./helpers/referral-code";
import { linkReferrer } from "./helpers/referral-linking";
import {
  validateLinkReferralSignature,
  validateChangeReferrerSignature,
  linkReferralSignatureRequestSchema,
  changeReferrerSignatureRequestSchema,
} from "../../signature-schemas/referral";
import {
  calculateReferrerShare,
  calculateRefereeBonus,
  getReferrerTier,
  getReferrerStats,
  applyPostLinkProration,
} from "../impact-router/helpers/referral-points";
import {
  computeGlowImpactScores,
  getCurrentWeekProjection,
  type GlowWorthResult,
} from "../impact-router/helpers/impact-score";
import {
  formatPointsScaled6,
  glwWeiToPointsScaled6,
} from "../impact-router/helpers/points";
import { viemClient } from "../../lib/web3-providers/viem-client";
import { getReferralNonce, canClaimReferrer } from "./helpers/referral-validation";
import { dateToEpoch, getCurrentEpoch, getProtocolWeek } from "../../utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../fractions-router/helpers/apy-helpers";
import pLimit from "p-limit";

const parseScaled6 = (val: string | undefined) => {
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
};

async function getReferrerBasePointsMap(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  if (params.wallets.length === 0) return map;
  const scores = await computeGlowImpactScores({
    walletAddresses: params.wallets,
    startWeek: params.startWeek,
    endWeek: params.endWeek,
    includeWeeklyBreakdown: false,
  });
  for (const score of scores) {
    map.set(
      score.walletAddress.toLowerCase(),
      parseScaled6(score.totals.basePointsPreMultiplierScaled6)
    );
  }
  return map;
}

export const referralRouter = new Elysia({ prefix: "/referral" })
  .get(
    "/internal/overview",
    async ({ set }) => {
      try {
        const currentWeek = getProtocolWeek();
        const [
          totalsRes,
          tierDistribution,
          totalCodesRes,
        ] = await Promise.all([
          db
            .select({
              totalReferrals: sql<number>`count(*)::int`,
              activeReferrals: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
              pendingReferrals: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
              inGracePeriod: sql<number>`count(*) filter (where ${referrals.gracePeriodEndsAt} > now())::int`,
              inBonusPeriod: sql<number>`count(*) filter (where ${referrals.refereeBonusEndsAt} > now())::int`,
              activationBonusesAwarded: sql<number>`count(*) filter (where ${referrals.activationBonusAwarded} = true)::int`,
            })
            .from(referrals),
          db
            .select({
              referrerWallet: referrals.referrerWallet,
              activeCount: sql<number>`count(*)::int`,
            })
            .from(referrals)
            .where(eq(referrals.status, "active"))
            .groupBy(referrals.referrerWallet),
          db
            .select({
              totalCodes: sql<number>`count(*)::int`,
            })
            .from(referralCodes),
        ]);

        const { startWeek, endWeek } = getWeekRangeForImpact();
        const tierWallets = Array.from(
          new Set(tierDistribution.map((row) => row.referrerWallet))
        );
        const referrerBasePointsByWallet = await getReferrerBasePointsMap({
          wallets: tierWallets,
          startWeek,
          endWeek,
        });

        const tiers = { seed: 0, grow: 0, scale: 0, legend: 0 };
        for (const row of tierDistribution) {
          const basePoints =
            referrerBasePointsByWallet.get(row.referrerWallet.toLowerCase()) ||
            0n;
          const count = basePoints > 0n ? row.activeCount : 0;
          if (count >= 7) tiers.legend++;
          else if (count >= 4) tiers.scale++;
          else if (count >= 2) tiers.grow++;
          else if (count >= 1) tiers.seed++;
        }

        return {
          overview: {
            totalReferrals: totalsRes[0]?.totalReferrals || 0,
            activeReferrals: totalsRes[0]?.activeReferrals || 0,
            pendingReferrals: totalsRes[0]?.pendingReferrals || 0,
            inGracePeriod: totalsRes[0]?.inGracePeriod || 0,
            inBonusPeriod: totalsRes[0]?.inBonusPeriod || 0,
            activationBonusesAwarded: totalsRes[0]?.activationBonusesAwarded || 0,
            totalCodesGenerated: totalCodesRes[0]?.totalCodes || 0,
            uniqueReferrers: tierDistribution.length,
          },
          tierDistribution: tiers,
          currentWeek,
        };
      } catch (e) {
        console.error("[Referral Dashboard] Overview error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard overview",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/internal/top-referrers",
    async ({ set }) => {
      try {
        const { startWeek, endWeek } = getWeekRangeForImpact();
        const topReferrers = await db
          .select({
            referrerWallet: referrals.referrerWallet,
            activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
            totalReferees: sql<number>`count(*)::int`,
            pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
          })
          .from(referrals)
          .groupBy(referrals.referrerWallet)
          .orderBy(desc(sql`count(*) filter (where ${referrals.status} = 'active')`))
          .limit(20);

        const wallets = topReferrers.map((row) => row.referrerWallet);
        const referrerBasePointsByWallet = await getReferrerBasePointsMap({
          wallets,
          startWeek,
          endWeek,
        });

        const topReferrersWithEns = await Promise.all(
          topReferrers.map(async (referrer) => {
            let ensName: string | undefined;
            try {
              ensName =
                (await viemClient.getEnsName({
                  address: referrer.referrerWallet as `0x${string}`,
                })) || undefined;
            } catch {}
            const basePoints =
              referrerBasePointsByWallet.get(
                referrer.referrerWallet.toLowerCase()
              ) || 0n;
            const tier = getReferrerTier(referrer.activeReferees, basePoints);
            return {
              ...referrer,
              ensName,
              tier: tier.name,
              tierPercent: Number(tier.percent),
            };
          })
        );

        return { topReferrers: topReferrersWithEns };
      } catch (e) {
        console.error("[Referral Dashboard] Top referrers error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard top referrers",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/internal/recent-referrals",
    async ({ set }) => {
      try {
        const recentReferrals = await db
          .select({
            referrerWallet: referrals.referrerWallet,
            refereeWallet: referrals.refereeWallet,
            status: referrals.status,
            linkedAt: referrals.linkedAt,
            activatedAt: referrals.activatedAt,
            gracePeriodEndsAt: referrals.gracePeriodEndsAt,
            referralCode: referrals.referralCode,
          })
          .from(referrals)
          .orderBy(desc(referrals.linkedAt))
          .limit(20);

        if (recentReferrals.length === 0) {
          return { recentReferrals: [] };
        }

        const { startWeek, endWeek } = getWeekRangeForImpact();
        const recentReferrerWallets = Array.from(
          new Set(recentReferrals.map((r) => r.referrerWallet.toLowerCase()))
        );
        const referrerBasePointsByWallet = await getReferrerBasePointsMap({
          wallets: recentReferrerWallets,
          startWeek,
          endWeek,
        });

        const recentReferrerStats = await db
          .select({
            referrerWallet: referrals.referrerWallet,
            activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
            pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
            totalReferees: sql<number>`count(*)::int`,
          })
          .from(referrals)
          .where(inArray(referrals.referrerWallet, recentReferrerWallets))
          .groupBy(referrals.referrerWallet);
        const countsByReferrer = new Map(
          recentReferrerStats.map((row) => [
            row.referrerWallet.toLowerCase(),
            {
              activeReferees: row.activeReferees,
              pendingReferees: row.pendingReferees,
              totalReferees: row.totalReferees,
            },
          ])
        );

        const recentRefereeWallets = Array.from(
          new Set(recentReferrals.map((r) => r.refereeWallet.toLowerCase()))
        );
        const linkedAtByReferee = new Map(
          recentReferrals.map((referral) => [
            referral.refereeWallet.toLowerCase(),
            referral.linkedAt,
          ])
        );

        const projectionWeekNumber = getCurrentEpoch(Math.floor(Date.now() / 1000));
        const glowWorthByReferee = new Map<string, GlowWorthResult>();
        if (recentRefereeWallets.length > 0) {
          try {
            const glowWorthResults = await computeGlowImpactScores({
              walletAddresses: recentRefereeWallets,
              startWeek: projectionWeekNumber,
              endWeek: projectionWeekNumber,
              includeWeeklyBreakdown: false,
            });
            for (const result of glowWorthResults) {
              glowWorthByReferee.set(
                result.walletAddress.toLowerCase(),
                result.glowWorth
              );
            }
          } catch (error) {
            console.error(
              "[Referral Dashboard] GlowWorth projection fetch failed",
              error
            );
          }
        }

        const projectedBasePointsByReferee = new Map<string, bigint>();
        if (recentRefereeWallets.length > 0) {
          const limitProjection = pLimit(8);
          await Promise.all(
            recentRefereeWallets.map((refereeWallet) =>
              limitProjection(async () => {
                try {
                  const projection = await getCurrentWeekProjection(
                    refereeWallet,
                    glowWorthByReferee.get(refereeWallet)
                  );
                  const basePointsScaled6 = parseScaled6(
                    projection.projectedPoints.basePointsPreMultiplierScaled6
                  );
                  const linkedAt = linkedAtByReferee.get(refereeWallet);
                  projectedBasePointsByReferee.set(
                    refereeWallet,
                    linkedAt
                      ? applyPostLinkProration({
                          basePointsScaled6,
                          linkedAt,
                          weekNumber: projectionWeekNumber,
                        })
                      : basePointsScaled6
                  );
                } catch {
                  projectedBasePointsByReferee.set(refereeWallet, 0n);
                }
              })
            )
          );
        }

        const projectedShareByReferee = new Map<string, bigint>();
        for (const referral of recentReferrals) {
          const refereeWallet = referral.refereeWallet.toLowerCase();
          const referrerWallet = referral.referrerWallet.toLowerCase();
          const projectedBasePoints =
            projectedBasePointsByReferee.get(refereeWallet) || 0n;
          const counts = countsByReferrer.get(referrerWallet);
          const activeReferees = counts?.activeReferees || 0;
          const totalReferees = counts?.totalReferees || activeReferees;
          const referrerBasePoints =
            referrerBasePointsByWallet.get(referrerWallet) || 0n;
          const networkCountForProjection =
            referral.status === "pending"
              ? Math.max(totalReferees, 1)
              : activeReferees;
          const projectedShare =
            projectedBasePoints > 0n
              ? calculateReferrerShare(
                  projectedBasePoints,
                  networkCountForProjection,
                  referrerBasePoints
                )
              : 0n;
          projectedShareByReferee.set(refereeWallet, projectedShare);
        }

        const now = new Date();
        const recent = recentReferrals.map((r) => ({
          ...r,
          linkedAt: r.linkedAt.toISOString(),
          activatedAt: r.activatedAt?.toISOString(),
          gracePeriodEndsAt: r.gracePeriodEndsAt.toISOString(),
          isInGracePeriod: now < r.gracePeriodEndsAt,
          referrerPendingPointsScaled6: formatPointsScaled6(
            projectedShareByReferee.get(r.refereeWallet.toLowerCase()) || 0n
          ),
          refereePendingPointsScaled6: formatPointsScaled6(
            projectedBasePointsByReferee.get(r.refereeWallet.toLowerCase()) || 0n
          ),
        }));

        return { recentReferrals: recent };
      } catch (e) {
        console.error("[Referral Dashboard] Recent referrals error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard recent referrals",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/internal/weekly-stats",
    async ({ set }) => {
      try {
        const currentWeek = getProtocolWeek();
        const [weeklyPointsRes, totalPointsRes] = await Promise.all([
          db
            .select({
              weekNumber: referralPointsWeekly.weekNumber,
              totalReferrerPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
              totalRefereeBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBonusPointsScaled6}), '0.000000')`,
              totalActivationBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.activationBonusPointsScaled6}), '0.000000')`,
              uniqueReferrers: sql<number>`count(distinct ${referralPointsWeekly.referrerWallet})::int`,
              uniqueReferees: sql<number>`count(distinct ${referralPointsWeekly.refereeWallet})::int`,
            })
            .from(referralPointsWeekly)
            .where(sql`${referralPointsWeekly.weekNumber} >= ${currentWeek - 12}`)
            .groupBy(referralPointsWeekly.weekNumber)
            .orderBy(desc(referralPointsWeekly.weekNumber)),
          db
            .select({
              totalReferrerPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
              totalRefereeBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBonusPointsScaled6}), '0.000000')`,
              totalActivationBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.activationBonusPointsScaled6}), '0.000000')`,
            })
            .from(referralPointsWeekly),
        ]);

        return {
          weeklyStats: weeklyPointsRes.map((w) => ({
            weekNumber: w.weekNumber,
            totalReferrerPoints: w.totalReferrerPoints,
            totalRefereeBonusPoints: w.totalRefereeBonusPoints,
            totalActivationBonusPoints: w.totalActivationBonusPoints,
            uniqueReferrers: w.uniqueReferrers,
            uniqueReferees: w.uniqueReferees,
          })),
          totalPointsAllTime: {
            referrerPoints: totalPointsRes[0]?.totalReferrerPoints || "0.000000",
            refereeBonusPoints: totalPointsRes[0]?.totalRefereeBonusPoints || "0.000000",
            activationBonusPoints: totalPointsRes[0]?.totalActivationBonusPoints || "0.000000",
          },
          currentWeek,
        };
      } catch (e) {
        console.error("[Referral Dashboard] Weekly stats error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard weekly stats",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/internal/new-referees",
    async ({ set }) => {
      try {
        const { endWeek } = getWeekRangeForImpact();
        const allReferrals = await db
          .select({
            refereeWallet: referrals.refereeWallet,
            referrerWallet: referrals.referrerWallet,
            linkedAt: referrals.linkedAt,
          })
          .from(referrals);

        const refereeMeta = new Map<
          string,
          { referrerWallet: string; linkedAt: Date }
        >();
        for (const row of allReferrals) {
          const referee = row.refereeWallet.toLowerCase();
          if (!refereeMeta.has(referee)) {
            refereeMeta.set(referee, {
              referrerWallet: row.referrerWallet.toLowerCase(),
              linkedAt: row.linkedAt,
            });
          }
        }

        const allRefereeWallets = Array.from(refereeMeta.keys());
        if (allRefereeWallets.length === 0) {
          return {
            newRefereeActivations: { total: 0, truncated: false, rows: [] },
          };
        }

        const lastWeekPointsByWallet = new Map<string, bigint>();
        const lastWeekRows = await db
          .select({
            walletAddress: impactLeaderboardCache.walletAddress,
            lastWeekPoints: impactLeaderboardCache.lastWeekPoints,
          })
          .from(impactLeaderboardCache)
          .where(inArray(impactLeaderboardCache.walletAddress, allRefereeWallets));

        for (const row of lastWeekRows) {
          lastWeekPointsByWallet.set(
            row.walletAddress.toLowerCase(),
            parseScaled6(String(row.lastWeekPoints))
          );
        }

        const newRefereeCandidates = allRefereeWallets.filter(
          (wallet) => (lastWeekPointsByWallet.get(wallet) || 0n) === 0n
        );

        const currentWeek = getCurrentEpoch(Math.floor(Date.now() / 1000));
        const glowWorthByCandidate = new Map<string, GlowWorthResult>();
        const candidateBatches: string[][] = [];
        for (let i = 0; i < newRefereeCandidates.length; i += 25) {
          candidateBatches.push(newRefereeCandidates.slice(i, i + 25));
        }
        for (const batch of candidateBatches) {
          const scores = await computeGlowImpactScores({
            walletAddresses: batch,
            startWeek: currentWeek,
            endWeek: currentWeek,
            includeWeeklyBreakdown: false,
          });
          for (const score of scores) {
            glowWorthByCandidate.set(
              score.walletAddress.toLowerCase(),
              score.glowWorth
            );
          }
        }

        const limitNewReferees = pLimit(10);
        const newRefereesRaw = await Promise.all(
          newRefereeCandidates.map((wallet) =>
            limitNewReferees(async () => {
              const projection = await getCurrentWeekProjection(
                wallet,
                glowWorthByCandidate.get(wallet)
              );
              const projectedBasePointsScaled6 = parseScaled6(
                projection.projectedPoints.basePointsPreMultiplierScaled6
              );
              if (projectedBasePointsScaled6 <= 0n) return null;

              const inflationPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.inflationGlwWei || "0"),
                BigInt(1_000_000)
              );
              const steeringPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.steeringGlwWei || "0"),
                BigInt(3_000_000)
              );
              const vaultPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.delegatedGlwWei || "0"),
                BigInt(5_000)
              );
              const worthPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.glowWorthWei || "0"),
                BigInt(1_000)
              );

              const meta = refereeMeta.get(wallet);
              return {
                refereeWallet: wallet,
                referrerWallet: meta?.referrerWallet ?? "unknown",
                linkedAt: meta?.linkedAt?.toISOString() ?? "",
                lastWeekBasePointsScaled6: formatPointsScaled6(
                  lastWeekPointsByWallet.get(wallet) || 0n
                ),
                projectedBasePointsScaled6: formatPointsScaled6(
                  projectedBasePointsScaled6
                ),
                inflationPointsScaled6: formatPointsScaled6(
                  inflationPointsScaled6
                ),
                steeringPointsScaled6: formatPointsScaled6(
                  steeringPointsScaled6
                ),
                vaultPointsScaled6: formatPointsScaled6(vaultPointsScaled6),
                worthPointsScaled6: formatPointsScaled6(worthPointsScaled6),
              };
            })
          )
        );

        const newRefereesFiltered = newRefereesRaw.filter(Boolean) as Array<
          NonNullable<(typeof newRefereesRaw)[number]>
        >;
        newRefereesFiltered.sort((a, b) =>
          parseScaled6(b.projectedBasePointsScaled6) >
          parseScaled6(a.projectedBasePointsScaled6)
            ? 1
            : -1
        );
        const NEW_REFEREES_LIMIT = 50;
        const newReferees =
          newRefereesFiltered.length > NEW_REFEREES_LIMIT
            ? newRefereesFiltered.slice(0, NEW_REFEREES_LIMIT)
            : newRefereesFiltered;

        return {
          newRefereeActivations: {
            total: newRefereesFiltered.length,
            truncated: newRefereesFiltered.length > NEW_REFEREES_LIMIT,
            rows: newReferees,
          },
        };
      } catch (e) {
        console.error("[Referral Dashboard] New referees error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard new referees",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/internal/dashboard",
    async ({ set }) => {
      try {
        const currentWeek = getProtocolWeek();

        // Get aggregate referral stats
        const [
          totalsRes,
          tierDistribution,
          topReferrers,
          recentReferrals,
          weeklyPointsRes,
          totalCodesRes,
          allReferrals,
        ] = await Promise.all([
          // Total referral counts by status
          db
            .select({
              totalReferrals: sql<number>`count(*)::int`,
              activeReferrals: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
              pendingReferrals: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
              inGracePeriod: sql<number>`count(*) filter (where ${referrals.gracePeriodEndsAt} > now())::int`,
              inBonusPeriod: sql<number>`count(*) filter (where ${referrals.refereeBonusEndsAt} > now())::int`,
              activationBonusesAwarded: sql<number>`count(*) filter (where ${referrals.activationBonusAwarded} = true)::int`,
            })
            .from(referrals),

          // Tier distribution (by active referees count)
          db
            .select({
              referrerWallet: referrals.referrerWallet,
              activeCount: sql<number>`count(*)::int`,
            })
            .from(referrals)
            .where(eq(referrals.status, "active"))
            .groupBy(referrals.referrerWallet),

          // Top referrers by active referees
          db
            .select({
              referrerWallet: referrals.referrerWallet,
              activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
              totalReferees: sql<number>`count(*)::int`,
              pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
            })
            .from(referrals)
            .groupBy(referrals.referrerWallet)
            .orderBy(desc(sql`count(*) filter (where ${referrals.status} = 'active')`))
            .limit(20),

          // Recent referrals (last 20)
          db
            .select({
              referrerWallet: referrals.referrerWallet,
              refereeWallet: referrals.refereeWallet,
              status: referrals.status,
              linkedAt: referrals.linkedAt,
              activatedAt: referrals.activatedAt,
              gracePeriodEndsAt: referrals.gracePeriodEndsAt,
              referralCode: referrals.referralCode,
            })
            .from(referrals)
            .orderBy(desc(referrals.linkedAt))
            .limit(20),

          // Weekly points totals (last 12 weeks)
          db
            .select({
              weekNumber: referralPointsWeekly.weekNumber,
              totalReferrerPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
              totalRefereeBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBonusPointsScaled6}), '0.000000')`,
              totalActivationBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.activationBonusPointsScaled6}), '0.000000')`,
              uniqueReferrers: sql<number>`count(distinct ${referralPointsWeekly.referrerWallet})::int`,
              uniqueReferees: sql<number>`count(distinct ${referralPointsWeekly.refereeWallet})::int`,
            })
            .from(referralPointsWeekly)
            .where(sql`${referralPointsWeekly.weekNumber} >= ${currentWeek - 12}`)
            .groupBy(referralPointsWeekly.weekNumber)
            .orderBy(desc(referralPointsWeekly.weekNumber)),

          // Total referral codes generated
          db
            .select({
              totalCodes: sql<number>`count(*)::int`,
            })
            .from(referralCodes),

          // All referees (for new-user detection)
          db
            .select({
              refereeWallet: referrals.refereeWallet,
              referrerWallet: referrals.referrerWallet,
              linkedAt: referrals.linkedAt,
            })
            .from(referrals),
        ]);

        const { startWeek, endWeek } = getWeekRangeForImpact();
        const tierWallets = Array.from(
          new Set(tierDistribution.map((row) => row.referrerWallet))
        );
        const referrerBasePointsByWallet = await getReferrerBasePointsMap({
          wallets: tierWallets,
          startWeek,
          endWeek,
        });

        const recentReferrerWallets = Array.from(
          new Set(recentReferrals.map((r) => r.referrerWallet.toLowerCase()))
        );
        const missingReferrerWallets = recentReferrerWallets.filter(
          (wallet) => !referrerBasePointsByWallet.has(wallet)
        );
        if (missingReferrerWallets.length > 0) {
          const extra = await getReferrerBasePointsMap({
            wallets: missingReferrerWallets,
            startWeek,
            endWeek,
          });
          for (const [wallet, points] of extra.entries()) {
            referrerBasePointsByWallet.set(wallet, points);
          }
        }

        // Calculate tier distribution (only referrers with >0 base points can advance)
        const tiers = { seed: 0, grow: 0, scale: 0, legend: 0 };
        for (const row of tierDistribution) {
          const basePoints =
            referrerBasePointsByWallet.get(row.referrerWallet.toLowerCase()) ||
            0n;
          const count = basePoints > 0n ? row.activeCount : 0;
          if (count >= 7) tiers.legend++;
          else if (count >= 4) tiers.scale++;
          else if (count >= 2) tiers.grow++;
          else if (count >= 1) tiers.seed++;
        }

        // Get total points earned all-time
        const totalPointsRes = await db
          .select({
            totalReferrerPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
            totalRefereeBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBonusPointsScaled6}), '0.000000')`,
            totalActivationBonusPoints: sql<string>`coalesce(sum(${referralPointsWeekly.activationBonusPointsScaled6}), '0.000000')`,
          })
          .from(referralPointsWeekly);

        // Resolve ENS names for top referrers
        const topReferrersWithEns = await Promise.all(
          topReferrers.map(async (referrer) => {
            let ensName: string | undefined;
            try {
              ensName =
                (await viemClient.getEnsName({
                  address: referrer.referrerWallet as `0x${string}`,
                })) || undefined;
            } catch {}
            const basePoints =
              referrerBasePointsByWallet.get(
                referrer.referrerWallet.toLowerCase()
              ) || 0n;
            const tier = getReferrerTier(referrer.activeReferees, basePoints);
            return {
              ...referrer,
              ensName,
              tier: tier.name,
              tierPercent: Number(tier.percent),
            };
          })
        );

        const recentRefereeWallets = Array.from(
          new Set(recentReferrals.map((r) => r.refereeWallet.toLowerCase()))
        );
        const recentReferrerStats =
          recentReferrerWallets.length > 0
            ? await db
                .select({
                  referrerWallet: referrals.referrerWallet,
                  activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
                  pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
                  totalReferees: sql<number>`count(*)::int`,
                })
                .from(referrals)
                .where(inArray(referrals.referrerWallet, recentReferrerWallets))
                .groupBy(referrals.referrerWallet)
            : [];
        const countsByReferrer = new Map(
          recentReferrerStats.map((row) => [
            row.referrerWallet.toLowerCase(),
            {
              activeReferees: row.activeReferees,
              pendingReferees: row.pendingReferees,
              totalReferees: row.totalReferees,
            },
          ])
        );

        const linkedAtByReferee = new Map(
          recentReferrals.map((referral) => [
            referral.refereeWallet.toLowerCase(),
            referral.linkedAt,
          ])
        );

        const projectionWeekNumber = getCurrentEpoch(Math.floor(Date.now() / 1000));
        const glowWorthByReferee = new Map<string, GlowWorthResult>();
        if (recentRefereeWallets.length > 0) {
          try {
            const glowWorthResults = await computeGlowImpactScores({
              walletAddresses: recentRefereeWallets,
              startWeek: projectionWeekNumber,
              endWeek: projectionWeekNumber,
              includeWeeklyBreakdown: false,
            });
            for (const result of glowWorthResults) {
              glowWorthByReferee.set(
                result.walletAddress.toLowerCase(),
                result.glowWorth
              );
            }
          } catch (error) {
            console.error(
              "[Referral Dashboard] GlowWorth projection fetch failed",
              error
            );
          }
        }

        const projectedBasePointsByReferee = new Map<string, bigint>();
        if (recentRefereeWallets.length > 0) {
          const limitProjection = pLimit(5);
          await Promise.all(
            recentRefereeWallets.map((refereeWallet) =>
              limitProjection(async () => {
                try {
                  const projection = await getCurrentWeekProjection(
                    refereeWallet,
                    glowWorthByReferee.get(refereeWallet)
                  );
                  const basePointsScaled6 = parseScaled6(
                    projection.projectedPoints.basePointsPreMultiplierScaled6
                  );
                  const linkedAt = linkedAtByReferee.get(refereeWallet);
                  projectedBasePointsByReferee.set(
                    refereeWallet,
                    linkedAt
                      ? applyPostLinkProration({
                          basePointsScaled6,
                          linkedAt,
                          weekNumber: projectionWeekNumber,
                        })
                      : basePointsScaled6
                  );
                } catch {
                  projectedBasePointsByReferee.set(refereeWallet, 0n);
                }
              })
            )
          );
        }

        const projectedShareByReferee = new Map<string, bigint>();
        for (const referral of recentReferrals) {
          const refereeWallet = referral.refereeWallet.toLowerCase();
          const referrerWallet = referral.referrerWallet.toLowerCase();
          const projectedBasePoints =
            projectedBasePointsByReferee.get(refereeWallet) || 0n;
          const counts = countsByReferrer.get(referrerWallet);
          const activeReferees = counts?.activeReferees || 0;
          const totalReferees = counts?.totalReferees || activeReferees;
          const referrerBasePoints =
            referrerBasePointsByWallet.get(referrerWallet) || 0n;
          const networkCountForProjection =
            referral.status === "pending"
              ? Math.max(totalReferees, 1)
              : activeReferees;
          const projectedShare =
            projectedBasePoints > 0n
              ? calculateReferrerShare(
                  projectedBasePoints,
                  networkCountForProjection,
                  referrerBasePoints
                )
              : 0n;
          projectedShareByReferee.set(refereeWallet, projectedShare);
        }

        const refereeMeta = new Map<
          string,
          { referrerWallet: string; linkedAt: Date }
        >();
        for (const row of allReferrals) {
          const referee = row.refereeWallet.toLowerCase();
          if (!refereeMeta.has(referee)) {
            refereeMeta.set(referee, {
              referrerWallet: row.referrerWallet.toLowerCase(),
              linkedAt: row.linkedAt,
            });
          }
        }

        const allRefereeWallets = Array.from(refereeMeta.keys());
        const lastWeekPointsByWallet = new Map<string, bigint>();
        if (allRefereeWallets.length > 0) {
          const lastWeekRows = await db
            .select({
              walletAddress: impactLeaderboardCache.walletAddress,
              lastWeekPoints: impactLeaderboardCache.lastWeekPoints,
            })
            .from(impactLeaderboardCache)
            .where(inArray(impactLeaderboardCache.walletAddress, allRefereeWallets));

          for (const row of lastWeekRows) {
            lastWeekPointsByWallet.set(
              row.walletAddress.toLowerCase(),
              parseScaled6(String(row.lastWeekPoints))
            );
          }
        }

        const newRefereeCandidates = allRefereeWallets.filter(
          (wallet) => (lastWeekPointsByWallet.get(wallet) || 0n) === 0n
        );

        const glowWorthByCandidate = new Map<string, GlowWorthResult>();
        const candidateBatches: string[][] = [];
        for (let i = 0; i < newRefereeCandidates.length; i += 25) {
          candidateBatches.push(newRefereeCandidates.slice(i, i + 25));
        }
        for (const batch of candidateBatches) {
          const scores = await computeGlowImpactScores({
            walletAddresses: batch,
            startWeek: currentWeek,
            endWeek: currentWeek,
            includeWeeklyBreakdown: false,
          });
          for (const score of scores) {
            glowWorthByCandidate.set(
              score.walletAddress.toLowerCase(),
              score.glowWorth
            );
          }
        }

        const limitNewReferees = pLimit(10);
        const newRefereesRaw = await Promise.all(
          newRefereeCandidates.map((wallet) =>
            limitNewReferees(async () => {
              const projection = await getCurrentWeekProjection(
                wallet,
                glowWorthByCandidate.get(wallet)
              );
              const projectedBasePointsScaled6 = parseScaled6(
                projection.projectedPoints.basePointsPreMultiplierScaled6
              );
              if (projectedBasePointsScaled6 <= 0n) return null;

              const inflationPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.inflationGlwWei || "0"),
                BigInt(1_000_000)
              );
              const steeringPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.steeringGlwWei || "0"),
                BigInt(3_000_000)
              );
              const vaultPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.delegatedGlwWei || "0"),
                BigInt(5_000)
              );
              const worthPointsScaled6 = glwWeiToPointsScaled6(
                BigInt(projection.projectedPoints.glowWorthWei || "0"),
                BigInt(1_000)
              );

              const meta = refereeMeta.get(wallet);
              return {
                refereeWallet: wallet,
                referrerWallet: meta?.referrerWallet ?? "unknown",
                linkedAt: meta?.linkedAt?.toISOString() ?? "",
                lastWeekBasePointsScaled6: formatPointsScaled6(
                  lastWeekPointsByWallet.get(wallet) || 0n
                ),
                projectedBasePointsScaled6: formatPointsScaled6(
                  projectedBasePointsScaled6
                ),
                inflationPointsScaled6: formatPointsScaled6(
                  inflationPointsScaled6
                ),
                steeringPointsScaled6: formatPointsScaled6(
                  steeringPointsScaled6
                ),
                vaultPointsScaled6: formatPointsScaled6(vaultPointsScaled6),
                worthPointsScaled6: formatPointsScaled6(worthPointsScaled6),
              };
            })
          )
        );

        const newRefereesFiltered = newRefereesRaw.filter(Boolean) as Array<
          NonNullable<(typeof newRefereesRaw)[number]>
        >;
        newRefereesFiltered.sort((a, b) =>
          parseScaled6(b.projectedBasePointsScaled6) >
          parseScaled6(a.projectedBasePointsScaled6)
            ? 1
            : -1
        );
        const NEW_REFEREES_LIMIT = 50;
        const newReferees =
          newRefereesFiltered.length > NEW_REFEREES_LIMIT
            ? newRefereesFiltered.slice(0, NEW_REFEREES_LIMIT)
            : newRefereesFiltered;

        return {
          overview: {
            totalReferrals: totalsRes[0]?.totalReferrals || 0,
            activeReferrals: totalsRes[0]?.activeReferrals || 0,
            pendingReferrals: totalsRes[0]?.pendingReferrals || 0,
            inGracePeriod: totalsRes[0]?.inGracePeriod || 0,
            inBonusPeriod: totalsRes[0]?.inBonusPeriod || 0,
            activationBonusesAwarded: totalsRes[0]?.activationBonusesAwarded || 0,
            totalCodesGenerated: totalCodesRes[0]?.totalCodes || 0,
            uniqueReferrers: tierDistribution.length,
          },
          tierDistribution: tiers,
          topReferrers: topReferrersWithEns,
          recentReferrals: recentReferrals.map((r) => ({
            ...r,
            linkedAt: r.linkedAt.toISOString(),
            activatedAt: r.activatedAt?.toISOString(),
            gracePeriodEndsAt: r.gracePeriodEndsAt.toISOString(),
            isInGracePeriod: new Date() < r.gracePeriodEndsAt,
            referrerPendingPointsScaled6: formatPointsScaled6(
              projectedShareByReferee.get(r.refereeWallet.toLowerCase()) || 0n
            ),
            refereePendingPointsScaled6: formatPointsScaled6(
              projectedBasePointsByReferee.get(r.refereeWallet.toLowerCase()) || 0n
            ),
          })),
          weeklyStats: weeklyPointsRes.map((w) => ({
            weekNumber: w.weekNumber,
            totalReferrerPoints: w.totalReferrerPoints,
            totalRefereeBonusPoints: w.totalRefereeBonusPoints,
            totalActivationBonusPoints: w.totalActivationBonusPoints,
            uniqueReferrers: w.uniqueReferrers,
            uniqueReferees: w.uniqueReferees,
          })),
          totalPointsAllTime: {
            referrerPoints: totalPointsRes[0]?.totalReferrerPoints || "0.000000",
            refereeBonusPoints: totalPointsRes[0]?.totalRefereeBonusPoints || "0.000000",
            activationBonusPoints: totalPointsRes[0]?.totalActivationBonusPoints || "0.000000",
          },
          newRefereeActivations: {
            total: newRefereesFiltered.length,
            truncated: newRefereesFiltered.length > NEW_REFEREES_LIMIT,
            rows: newReferees,
          },
          currentWeek,
        };
      } catch (e) {
        console.error("[Referral Dashboard] Error:", e);
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Internal referral dashboard stats",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/code",
    async ({ query: { walletAddress }, set }) => {
      try {
        if (!walletAddress) {
          set.status = 400;
          return "walletAddress required";
        }
        const record = await getOrCreateReferralCode(walletAddress);
        return {
          code: record.code,
          shareableLink: record.shareableLink,
        };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
      }),
      detail: {
        summary: "Get or generate referral code for wallet",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .post(
    "/link",
    async ({ body, set }) => {
      try {
        // 1. Signature validation
        const sigResult = await validateLinkReferralSignature(body);
        if (!sigResult.valid) {
          set.status = 401;
          return sigResult.reason || "Signature verification failed";
        }

        // 2. Link logic
        const record = await getReferralCodeRecordByCode(body.referralCode);
        if (!record) {
          set.status = 404;
          return "Invalid referral code";
        }

        const referral = await linkReferrer({
          refereeWallet: body.wallet,
          referralCode: body.referralCode,
          referrerWallet: record.walletAddress,
          nonce: body.nonce,
        });

        return {
          success: true,
          referral: {
            referrerWallet: referral.referrerWallet,
            linkedAt: referral.linkedAt.toISOString(),
            gracePeriodEndsAt: referral.gracePeriodEndsAt.toISOString(),
            refereeBonusEndsAt: referral.refereeBonusEndsAt.toISOString(),
            status: referral.status,
          },
          message: "Referrer linked successfully",
        };
      } catch (e) {
        set.status = 400;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      body: linkReferralSignatureRequestSchema,
      detail: {
        summary: "Link referee to referrer via code (Requires signature)",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .post(
    "/change",
    async ({ body, set }) => {
      try {
        // 1. Signature validation
        const sigResult = await validateChangeReferrerSignature(body);
        if (!sigResult.valid) {
          set.status = 401;
          return sigResult.reason || "Signature verification failed";
        }

        // 2. Resolve new referrer
        const record = await getReferralCodeRecordByCode(body.newReferralCode);
        if (!record) {
          set.status = 404;
          return "Invalid new referral code";
        }

        // 3. Link logic (handles grace period checks internally)
        const referral = await linkReferrer({
          refereeWallet: body.wallet,
          referralCode: body.newReferralCode,
          referrerWallet: record.walletAddress,
          nonce: body.nonce,
          requireExisting: true,
        });

        return {
          success: true,
          referral: {
            referrerWallet: referral.referrerWallet,
            previousReferrerWallet: referral.previousReferrerWallet,
            linkedAt: referral.linkedAt.toISOString(),
            gracePeriodEndsAt: referral.gracePeriodEndsAt.toISOString(),
            refereeBonusEndsAt: referral.refereeBonusEndsAt.toISOString(),
            status: referral.status,
          },
          message: "Referrer changed successfully",
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Error Occurred";
        if (message === "No existing referral") {
          set.status = 404;
          return message;
        }
        set.status = 400;
        return message;
      }
    },
    {
      body: changeReferrerSignatureRequestSchema,
      detail: {
        summary: "Change referrer (Within 7-day grace period, Requires signature)",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/network",
    async ({ query: { walletAddress, limit }, set }) => {
      try {
        const normalizedWallet = walletAddress.toLowerCase();
        const parsedLimit = limit ? parseInt(limit) : 50;
        const ACTIVATION_THRESHOLD_SCALED6 = 100_000_000n;
        const currentWeek = getCurrentEpoch(Math.floor(Date.now() / 1000));

        const codeRecord = await getOrCreateReferralCode(normalizedWallet);
        const maxWeekRes = await db
          .select({
            maxWeek: sql<number>`max(${referralPointsWeekly.weekNumber})`,
          })
          .from(referralPointsWeekly);
        const maxWeek = maxWeekRes[0]?.maxWeek;

        const stats = await getReferrerStats(normalizedWallet, maxWeek);
        const { startWeek, endWeek } = getWeekRangeForImpact();
        let referrerBasePointsScaled6 = 0n;
        try {
          const referrerScore = await computeGlowImpactScores({
            walletAddresses: [normalizedWallet],
            startWeek,
            endWeek,
            includeWeeklyBreakdown: false,
          });
          referrerBasePointsScaled6 = parseScaled6(
            referrerScore[0]?.totals.basePointsPreMultiplierScaled6
          );
        } catch {
          referrerBasePointsScaled6 = 0n;
        }
        const totalsRes = await db
          .select({
            totalReferees: sql<number>`count(*)::int`,
            activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
            pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
          })
          .from(referrals)
          .where(eq(referrals.referrerWallet, normalizedWallet));

        const totalReferees = totalsRes[0]?.totalReferees || 0;
        const activeReferees = totalsRes[0]?.activeReferees || 0;
        const pendingReferees = totalsRes[0]?.pendingReferees || 0;
        const tier = getReferrerTier(activeReferees, referrerBasePointsScaled6);

        const allReferees = await db
          .select({
            refereeWallet: referrals.refereeWallet,
            status: referrals.status,
            linkedAt: referrals.linkedAt,
          })
          .from(referrals)
          .where(eq(referrals.referrerWallet, normalizedWallet));

        const refereeList = await db
          .select({
            refereeWallet: referrals.refereeWallet,
            status: referrals.status,
            linkedAt: referrals.linkedAt,
            activatedAt: referrals.activatedAt,
            gracePeriodEndsAt: referrals.gracePeriodEndsAt,
          })
          .from(referrals)
          .where(eq(referrals.referrerWallet, normalizedWallet))
          .orderBy(desc(referrals.linkedAt))
          .limit(parsedLimit);

        // Fetch recent weekly points for these referees
        const refereeWallets = refereeList.map((r) => r.refereeWallet);
        let weeklyPoints: any[] = [];

        if (refereeWallets.length > 0) {
          weeklyPoints = await db
            .select({
              refereeWallet: referralPointsWeekly.refereeWallet,
              thisWeekPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}) filter (where ${referralPointsWeekly.weekNumber} = ${maxWeek || 0}), '0.000000')`,
              lifetimePoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
            })
            .from(referralPointsWeekly)
            .where(inArray(referralPointsWeekly.refereeWallet, refereeWallets))
            .groupBy(referralPointsWeekly.refereeWallet);
        }

        const pointsMap = new Map(
          weeklyPoints.map((p) => [p.refereeWallet, p])
        );

        const refereeWalletsAll = Array.from(
          new Set(allReferees.map((r) => r.refereeWallet.toLowerCase()))
        );
        const activationStartWeekByReferee = new Map<string, number>();
        const linkedAtByReferee = new Map<string, Date>();
        for (const ref of allReferees) {
          linkedAtByReferee.set(
            ref.refereeWallet.toLowerCase(),
            ref.linkedAt
          );
          activationStartWeekByReferee.set(
            ref.refereeWallet.toLowerCase(),
            dateToEpoch(ref.linkedAt)
          );
        }

        const glowWorthByReferee = new Map<string, GlowWorthResult>();
        if (refereeWalletsAll.length > 0) {
          try {
            const glowWorthResults = await computeGlowImpactScores({
              walletAddresses: refereeWalletsAll,
              startWeek: currentWeek,
              endWeek: currentWeek,
              includeWeeklyBreakdown: false,
            });
            for (const result of glowWorthResults) {
              glowWorthByReferee.set(
                result.walletAddress.toLowerCase(),
                result.glowWorth
              );
            }
          } catch (error) {
            console.error(
              "[Referral] GlowWorth projection fetch failed",
              error
            );
          }
        }

        const historicalBasePointsByReferee = new Map<string, bigint>();
        if (refereeWalletsAll.length > 0) {
          const basePointRows = await db
            .select({
              refereeWallet: referralPointsWeekly.refereeWallet,
              weekNumber: referralPointsWeekly.weekNumber,
              basePoints: referralPointsWeekly.refereeBasePointsScaled6,
            })
            .from(referralPointsWeekly)
            .where(inArray(referralPointsWeekly.refereeWallet, refereeWalletsAll));

          for (const row of basePointRows) {
            const refereeWallet = row.refereeWallet.toLowerCase();
            const activationStartWeek =
              activationStartWeekByReferee.get(refereeWallet);
            if (activationStartWeek == null) continue;
            if (row.weekNumber < activationStartWeek) continue;
            const basePoints = parseScaled6(row.basePoints);
            if (basePoints <= 0n) continue;
            historicalBasePointsByReferee.set(
              refereeWallet,
              (historicalBasePointsByReferee.get(refereeWallet) || 0n) +
                basePoints
            );
          }
        }

        const projectedBasePointsByReferee = new Map<string, bigint>();
        const projectionWeekNumber = currentWeek;
        if (refereeWalletsAll.length > 0) {
          const limitProjection = pLimit(5);
          await Promise.all(
            refereeWalletsAll.map((refereeWallet) =>
              limitProjection(async () => {
                try {
                  const projection = await getCurrentWeekProjection(
                    refereeWallet,
                    glowWorthByReferee.get(refereeWallet)
                  );
                  const basePointsScaled6 = parseScaled6(
                    projection.projectedPoints.basePointsPreMultiplierScaled6
                  );
                  const linkedAt = linkedAtByReferee.get(refereeWallet);
                  projectedBasePointsByReferee.set(
                    refereeWallet,
                    linkedAt
                      ? applyPostLinkProration({
                          basePointsScaled6,
                          linkedAt,
                          weekNumber: projectionWeekNumber,
                        })
                      : basePointsScaled6
                  );
                } catch {
                  projectedBasePointsByReferee.set(refereeWallet, 0n);
                }
              })
            )
          );
        }

        const activationPendingByReferee = new Map<string, boolean>();
        for (const ref of allReferees) {
          const refereeWallet = ref.refereeWallet.toLowerCase();
          const activationStartWeek =
            activationStartWeekByReferee.get(refereeWallet) ?? currentWeek;
          const historicalBasePoints =
            historicalBasePointsByReferee.get(refereeWallet) || 0n;
          const projectedBasePoints =
            projectedBasePointsByReferee.get(refereeWallet) || 0n;
          const includeProjected = currentWeek >= activationStartWeek;
          const postLinkBasePoints =
            historicalBasePoints + (includeProjected ? projectedBasePoints : 0n);
          const activationPending =
            ref.status === "pending" &&
            includeProjected &&
            postLinkBasePoints >= ACTIVATION_THRESHOLD_SCALED6;
          activationPendingByReferee.set(refereeWallet, activationPending);
        }

        const projectedActivationCount = Array.from(
          activationPendingByReferee.values()
        ).filter(Boolean).length;
        const projectedActiveCount =
          activeReferees + projectedActivationCount;

        const projectedShareByReferee = new Map<string, bigint>();
        let projectedTotalPoints = 0n;
        for (const ref of allReferees) {
          const refereeWallet = ref.refereeWallet.toLowerCase();
          const projectedBasePoints =
            projectedBasePointsByReferee.get(refereeWallet) || 0n;
          const activationPending =
            activationPendingByReferee.get(refereeWallet) || false;
          const willEarn =
            ref.status === "active" || activationPending;
          const projectedShare =
            willEarn && projectedBasePoints > 0n
              ? calculateReferrerShare(
                  projectedBasePoints,
                  projectedActiveCount,
                  referrerBasePointsScaled6
                )
              : 0n;
          projectedShareByReferee.set(refereeWallet, projectedShare);
          projectedTotalPoints += projectedShare;
        }

        const now = new Date();
        const useProjectedThisWeek = maxWeek == null || currentWeek > maxWeek;
        const referees = await Promise.all(
          refereeList.map(async (r) => {
            const p = pointsMap.get(r.refereeWallet);
            let ensName: string | undefined;
            try {
              ensName =
                (await viemClient.getEnsName({
                  address: r.refereeWallet as `0x${string}`,
                })) || undefined;
            } catch {}

            return {
              ...r,
              ensName,
              linkedAt: r.linkedAt.toISOString(),
              activatedAt: r.activatedAt?.toISOString(),
              gracePeriodEndsAt: r.gracePeriodEndsAt.toISOString(),
              isInGracePeriod: now < r.gracePeriodEndsAt,
              thisWeekPointsScaled6: useProjectedThisWeek
                ? formatPointsScaled6(
                    projectedShareByReferee.get(
                      r.refereeWallet.toLowerCase()
                    ) || 0n
                  )
                : p?.thisWeekPoints || "0.000000",
              lifetimePointsScaled6: p?.lifetimePoints || "0.000000",
              projectedThisWeekPointsScaled6: formatPointsScaled6(
                projectedShareByReferee.get(
                  r.refereeWallet.toLowerCase()
                ) || 0n
              ),
              activationPending:
                activationPendingByReferee.get(
                  r.refereeWallet.toLowerCase()
                ) || false,
            };
          })
        );

        const response = {
          walletAddress: normalizedWallet,
          code: codeRecord.code,
          shareableLink: codeRecord.shareableLink,
          stats: {
            totalReferees,
            activeReferees,
            pendingReferees,
            activationPendingReferees: projectedActivationCount,
            totalPointsEarnedScaled6: stats.totalPointsEarnedScaled6,
            thisWeekPointsScaled6: useProjectedThisWeek
              ? formatPointsScaled6(projectedTotalPoints)
              : stats.thisWeekPointsScaled6,
            projectedThisWeekPointsScaled6: formatPointsScaled6(
              projectedTotalPoints
            ),
            lifetimePointsScaled6: stats.totalPointsEarnedScaled6,
            currentTier: tier,
          },
          referees,
          projectionWeekNumber,
          milestones: {
            firstReferral: { unlocked: totalReferees >= 1 },
            networkBuilder: {
              unlocked: activeReferees >= 5,
              progress: activeReferees,
              target: 5,
            },
            powerBroker: {
              unlocked: activeReferees >= 10,
              progress: activeReferees,
              target: 10,
            },
            legendStatus: {
              unlocked: activeReferees >= 25,
              progress: activeReferees,
              target: 25,
            },
          },
        };
        return response;
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
        limit: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get referrer's network (list of referees)",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/status",
    async ({ query: { walletAddress, includeProjection }, set }) => {
      try {
        const normalizedWallet = walletAddress.toLowerCase();
        const [referral, nonce, claimCheck, featureSeen] = await Promise.all([
          db.query.referrals.findFirst({
            where: (r, { eq, sql }) => eq(sql`lower(${r.refereeWallet})`, normalizedWallet),
          }),
          getReferralNonce(normalizedWallet),
          canClaimReferrer(normalizedWallet),
          db.query.referralFeatureLaunchSeen.findFirst({
            where: eq(referralFeatureLaunchSeen.walletAddress, normalizedWallet),
          }),
        ]);

        let referrerEns: string | undefined;
        if (referral) {
          try {
            referrerEns = (await viemClient.getEnsName({ address: referral.referrerWallet as `0x${string}` })) || undefined;
          } catch {}
        }

        const now = new Date();

        let bonusProjectedPointsScaled6: string | undefined;
        if (referral && includeProjection === "1") {
          try {
            const { startWeek, endWeek } = getWeekRangeForImpact();
            const scores = await computeGlowImpactScores({
              walletAddresses: [normalizedWallet],
              startWeek,
              endWeek,
              includeWeeklyBreakdown: false,
            });
            const glowWorth = scores[0]?.glowWorth;
            const projection = await getCurrentWeekProjection(normalizedWallet, glowWorth);
            const projectedBasePointsRaw = parseScaled6(
              projection.projectedPoints.basePointsPreMultiplierScaled6
            );
            const projectedBasePointsScaled6 = applyPostLinkProration({
              basePointsScaled6: projectedBasePointsRaw,
              linkedAt: referral.linkedAt,
              weekNumber: projection.weekNumber,
            });
            const bonusScaled6 =
              new Date() < referral.refereeBonusEndsAt
                ? calculateRefereeBonus(projectedBasePointsScaled6)
                : 0n;
            bonusProjectedPointsScaled6 = formatPointsScaled6(bonusScaled6);
          } catch (error) {
            console.error("[Referral Status] Projection fetch failed", error);
            bonusProjectedPointsScaled6 = "0.000000";
          }
        }

        return {
          nonce: nonce.toString(),
          canClaim: claimCheck.canClaim,
          claimReason: claimCheck.reason,
          hasReferrer: !!referral,
          referrer: referral ? {
            wallet: referral.referrerWallet,
            ensName: referrerEns,
            linkedAt: referral.linkedAt.toISOString(),
            gracePeriodEndsAt: referral.gracePeriodEndsAt.toISOString(),
            isInGracePeriod: now < referral.gracePeriodEndsAt,
            canChangeReferrer: now < referral.gracePeriodEndsAt,
          } : undefined,
          bonus: referral ? {
            isActive: now < referral.refereeBonusEndsAt,
            endsAt: referral.refereeBonusEndsAt.toISOString(),
            weeksRemaining: Math.max(0, Math.ceil((referral.refereeBonusEndsAt.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000))),
            bonusPercent: 10,
            bonusProjectedPointsScaled6,
          } : undefined,
          // Modal tracking (replaces localStorage)
          featureLaunchModal: (() => {
            const seenAt =
              referral?.featureLaunchSeenAt ?? featureSeen?.featureLaunchSeenAt;
            return {
              seen: !!seenAt,
              seenAt: seenAt?.toISOString(),
            };
          })(),
          activationBonus: referral ? {
            awarded: referral.activationBonusAwarded,
            awardedAt: referral.activationBonusAwardedAt?.toISOString(),
            pointsAwarded: referral.activationBonusAwarded ? 100 : 0,
            celebrationSeen: !!referral.activationCelebrationSeenAt,
            celebrationSeenAt: referral.activationCelebrationSeenAt?.toISOString(),
          } : undefined,
        };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
        includeProjection: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get referee's referral status (who referred them)",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/validate/:code",
    async ({ params: { code }, set }) => {
      try {
        const record = await getReferralCodeRecordByCode(code);
        if (!record) {
          return { valid: false, message: "Invalid referral code" };
        }

        let referrerEns: string | undefined;
        try {
          referrerEns = (await viemClient.getEnsName({ address: record.walletAddress as `0x${string}` })) || undefined;
        } catch {}

        return {
          valid: true,
          referrerWallet: record.walletAddress,
          referrerEns,
          message: "Valid code",
        };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      params: t.Object({
        code: t.String(),
      }),
      detail: {
        summary: "Validate a referral code",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .post(
    "/feature-launch-seen",
    async ({ body, set }) => {
      try {
        const normalizedWallet = body.walletAddress.toLowerCase();

        // Check if user has a referral record (as referee)
        const existing = await db.query.referrals.findFirst({
          where: (r, { eq, sql }) => eq(sql`lower(${r.refereeWallet})`, normalizedWallet),
        });

        const now = new Date();
        if (existing) {
          // Update existing record
          await db
            .update(referrals)
            .set({
              featureLaunchSeenAt: now,
              updatedAt: now,
            })
            .where(eq(referrals.refereeWallet, existing.refereeWallet));
        } else {
          await db
            .insert(referralFeatureLaunchSeen)
            .values({
              walletAddress: normalizedWallet,
              featureLaunchSeenAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: referralFeatureLaunchSeen.walletAddress,
              set: { featureLaunchSeenAt: now, updatedAt: now },
            });
        }

        return { success: true };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      body: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
      }),
      detail: {
        summary: "Mark feature launch modal as seen",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .post(
    "/activation-seen",
    async ({ body, set }) => {
      try {
        const normalizedWallet = body.walletAddress.toLowerCase();

        // Find the referral record for this referee
        const existing = await db.query.referrals.findFirst({
          where: (r, { eq, sql }) => eq(sql`lower(${r.refereeWallet})`, normalizedWallet),
        });

        if (!existing) {
          set.status = 404;
          return "No referral record found";
        }

        // Update the activation celebration seen timestamp
        await db
          .update(referrals)
          .set({
            activationCelebrationSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(referrals.refereeWallet, existing.refereeWallet));

        return { success: true };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      body: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
      }),
      detail: {
        summary: "Mark activation celebration modal as seen",
        tags: [TAG.REFERRALS],
      },
    }
  )
  .get(
    "/leaderboard",
    async ({ query: { limit, sortBy }, set }) => {
      try {
        const parsedLimit = limit ? parseInt(limit) : 10;
        const sort =
          sortBy === "network"
            ? "network"
            : sortBy === "hybrid"
            ? "hybrid"
            : "points";

        const parseEnvWeek = (value: string | undefined) => {
          if (!value) return undefined;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
        };

        const [pointsRows, activeCountRows] = await Promise.all([
          db
            .select({
              referrerWallet: referralPointsWeekly.referrerWallet,
              totalPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
            })
            .from(referralPointsWeekly)
            .groupBy(referralPointsWeekly.referrerWallet),
          db
            .select({
              referrerWallet: referrals.referrerWallet,
              activeCount: sql<number>`count(*)::int`,
            })
            .from(referrals)
            .where(eq(referrals.status, "active"))
            .groupBy(referrals.referrerWallet),
        ]);

        const pointsMap = new Map(
          pointsRows.map((row) => [row.referrerWallet, row.totalPoints])
        );
        const activeCountMap = new Map(
          activeCountRows.map((row) => [row.referrerWallet, row.activeCount])
        );

        const allWallets = new Set<string>([
          ...pointsMap.keys(),
          ...activeCountMap.keys(),
        ]);

        const entries = Array.from(allWallets).map((wallet) => {
          const totalReferralPoints = pointsMap.get(wallet) || "0.000000";
          const activeReferralCount = activeCountMap.get(wallet) || 0;
          const totalPointsNumber = Number(totalReferralPoints) || 0;
          const hybridScore = 0.6 * totalPointsNumber + 0.4 * activeReferralCount;
          return {
            wallet,
            totalReferralPoints,
            activeReferralCount,
            totalPointsNumber,
            hybridScore,
          };
        });

        entries.sort((a, b) => {
          if (sort === "network") {
            if (a.activeReferralCount !== b.activeReferralCount) {
              return b.activeReferralCount - a.activeReferralCount;
            }
            return b.totalPointsNumber - a.totalPointsNumber;
          }
          if (sort === "hybrid") {
            if (a.hybridScore !== b.hybridScore) {
              return b.hybridScore - a.hybridScore;
            }
            return b.totalPointsNumber - a.totalPointsNumber;
          }
          if (a.totalPointsNumber !== b.totalPointsNumber) {
            return b.totalPointsNumber - a.totalPointsNumber;
          }
          return b.activeReferralCount - a.activeReferralCount;
        });

        const limitedEntries = entries.slice(0, parsedLimit);
        const { startWeek, endWeek } = getWeekRangeForImpact();
        const basePointsByWallet = new Map<string, bigint>();
        if (limitedEntries.length > 0) {
          const scores = await computeGlowImpactScores({
            walletAddresses: limitedEntries.map((entry) => entry.wallet),
            startWeek,
            endWeek,
            includeWeeklyBreakdown: false,
          });
          for (const score of scores) {
            basePointsByWallet.set(
              score.walletAddress.toLowerCase(),
              parseScaled6(score.totals.basePointsPreMultiplierScaled6)
            );
          }
        }
        const leaderboard = await Promise.all(
          limitedEntries.map(async (entry, idx) => {
            let displayName: string | undefined;
            try {
              displayName =
                (await viemClient.getEnsName({
                  address: entry.wallet as `0x${string}`,
                })) || undefined;
            } catch {}

            const basePoints =
              basePointsByWallet.get(entry.wallet.toLowerCase()) || 0n;
            const tier = getReferrerTier(entry.activeReferralCount, basePoints);

            return {
              rank: idx + 1,
              wallet: entry.wallet,
              displayName,
              totalReferralPoints: entry.totalReferralPoints,
              activeReferralCount: entry.activeReferralCount,
              currentTier: { name: tier.name, percent: Number(tier.percent) },
              hybridScore: sort === "hybrid" ? entry.hybridScore : undefined,
            };
          })
        );

        const eligibleForGiveaway = Array.from(activeCountMap.values()).filter(
          (count) => count >= 3
        ).length;

        const currentWeek = getProtocolWeek();
        const giveawayStartWeek = parseEnvWeek(
          process.env.REFERRAL_GIVEAWAY_START_WEEK
        );
        const giveawayEndWeek = parseEnvWeek(
          process.env.REFERRAL_GIVEAWAY_END_WEEK
        );
        const giveawaySnapshotWeek =
          parseEnvWeek(process.env.REFERRAL_GIVEAWAY_SNAPSHOT_WEEK) ??
          giveawayEndWeek;

        let eventStatus: "upcoming" | "active" | "completed" = "upcoming";
        if (giveawayStartWeek != null && giveawayEndWeek != null) {
          if (currentWeek < giveawayStartWeek) {
            eventStatus = "upcoming";
          } else if (currentWeek <= giveawayEndWeek) {
            eventStatus = "active";
          } else {
            eventStatus = "completed";
          }
        }

        return {
          leaderboard,
          eligibleForGiveaway,
          eventStatus,
          snapshotWeek: giveawaySnapshotWeek,
        };
      } catch (e) {
        set.status = 500;
        return e instanceof Error ? e.message : "Error Occurred";
      }
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        sortBy: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get referral giveaway leaderboard (Post-MVP)",
        tags: [TAG.REFERRALS],
      },
    }
  );

async function getReferralCodeRecordByCode(code: string) {
  return await db.query.referralCodes.findFirst({
    where: eq(referralCodes.code, code),
  });
}
