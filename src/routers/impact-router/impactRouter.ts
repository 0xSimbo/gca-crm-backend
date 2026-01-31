import { Elysia, t } from "elysia";
import { desc, asc, sql, and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db";
import {
  impactLeaderboardCache,
  referralPointsWeekly,
  fractionSplits,
  RewardsSplitsHistory,
} from "../../db/schema";
import { TAG } from "../../constants";
import { excludedLeaderboardWalletsSet } from "../../constants/excluded-wallets";
import { getWeekRangeForImpact } from "../fractions-router/helpers/apy-helpers";
import { dateToEpoch, getCurrentEpoch } from "../../utils/getProtocolWeek";
import {
  computeDelegatorsLeaderboard,
  computeGlowImpactScores,
  getCurrentWeekProjection,
  getAllImpactWallets,
  getImpactLeaderboardWalletUniverse,
} from "./helpers/impact-score";
import { populateReferralData } from "./helpers/referral-points";
import { formatPointsScaled6 } from "./helpers/points";
import {
  fetchDepositSplitsHistoryBatch,
  fetchGlwBalanceSnapshotByWeekMany,
  fetchNewGlwHoldersByWeek,
  fetchGctlStakersFromControlApi,
  fetchWalletStakeByEpochRange,
} from "./helpers/control-api";
import { getWalletPurchaseTypesByFarmUpToWeek } from "../fractions-router/helpers/per-piece-helpers";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

type ImpactLeaderboardSortKey = "totalPoints" | "lastWeekPoints" | "glowWorth";
type SortDir = "asc" | "desc";

function parseImpactLeaderboardSortKey(
  value: string | undefined
): ImpactLeaderboardSortKey | null {
  if (!value) return null;
  if (value === "totalPoints") return "totalPoints";
  if (value === "lastWeekPoints") return "lastWeekPoints";
  if (value === "glowWorth") return "glowWorth";
  return null;
}

function parseSortDir(value: string | undefined): SortDir | null {
  if (!value) return null;
  if (value === "asc") return "asc";
  if (value === "desc") return "desc";
  return null;
}

function createRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

const GLOW_SCORE_LIST_CACHE_TTL_MS = 10 * 60_000;
const glowScoreListCache = new Map<
  string,
  { expiresAtMs: number; data: unknown }
>();

const DELEGATORS_LEADERBOARD_CACHE_TTL_MS = 10 * 60_000;
const delegatorsLeaderboardCache = new Map<
  string,
  { expiresAtMs: number; data: unknown }
>();

const MIN_POINTS_THRESHOLD = 0.01;

function filterLeaderboardWallets(wallets: string[]): string[] {
  return wallets.filter((w) => !excludedLeaderboardWalletsSet.has(w));
}

function getGlowScoreListCacheKey(params: {
  startWeek: number;
  endWeek: number;
  limit: number;
  includeWeekly: boolean;
  limitWasProvided: boolean;
  sort: ImpactLeaderboardSortKey;
  dir: SortDir;
}): string {
  return [
    params.startWeek,
    params.endWeek,
    params.limit,
    params.includeWeekly ? 1 : 0,
    params.limitWasProvided ? 1 : 0,
    params.sort,
    params.dir,
  ].join(":");
}

function readCachedGlowScoreList(key: string): unknown | null {
  const cached = glowScoreListCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAtMs) {
    glowScoreListCache.delete(key);
    return null;
  }
  return cached.data;
}

function readCachedDelegatorsLeaderboard(key: string): unknown | null {
  const cached = delegatorsLeaderboardCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAtMs) {
    delegatorsLeaderboardCache.delete(key);
    return null;
  }
  return cached.data;
}

async function getLeaderboardWalletsForRange(params: {
  startWeek: number;
  endWeek: number;
}): Promise<string[]> {
  const rows = await db
    .select({
      wallet: impactLeaderboardCache.walletAddress,
      totalPoints: impactLeaderboardCache.totalPoints,
    })
    .from(impactLeaderboardCache)
    .where(
      and(
        eq(impactLeaderboardCache.startWeek, params.startWeek),
        eq(impactLeaderboardCache.endWeek, params.endWeek)
      )
    );

  return rows
    .map((row) => ({
      wallet: (row.wallet || "").toLowerCase(),
      points: Number(row.totalPoints),
    }))
    .filter(
      (row) =>
        row.wallet &&
        Number.isFinite(row.points) &&
        row.points >= MIN_POINTS_THRESHOLD &&
        !excludedLeaderboardWalletsSet.has(row.wallet)
    )
    .map((row) => row.wallet);
}

function updateEarliestWeek(
  map: Map<string, number>,
  wallet: string,
  week: number
) {
  if (!Number.isFinite(week)) return;
  const w = wallet.toLowerCase();
  if (!w) return;
  const prev = map.get(w);
  if (prev == null || week < prev) map.set(w, week);
}

async function getFirstStakeWeekByWallet(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
  concurrency?: number;
}): Promise<Map<string, number>> {
  const { wallets, startWeek, endWeek, concurrency = 6 } = params;
  const results = new Map<string, number>();
  const queue = wallets.slice();

  const worker = async () => {
    while (queue.length > 0) {
      const wallet = queue.shift();
      if (!wallet) continue;
      try {
        const stakeMap = await fetchWalletStakeByEpochRange({
          walletAddress: wallet,
          startWeek,
          endWeek,
        });
        let firstWeek: number | null = null;
        for (const [week, regions] of stakeMap) {
          if (!Number.isFinite(week)) continue;
          const hasStake = regions.some((r) => r.totalStakedWei > 0n);
          if (!hasStake) continue;
          if (firstWeek == null || week < firstWeek) firstWeek = week;
        }
        if (firstWeek != null) results.set(wallet.toLowerCase(), firstWeek);
      } catch {
        // ignore stake failures for individual wallets
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, concurrency) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export const impactRouter = new Elysia({ prefix: "/impact" })
  .get(
    "/glow-worth",
    async ({ query: { walletAddress, startWeek, endWeek, limit }, set }) => {
      try {
        const weekRange = getWeekRangeForImpact();
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? weekRange.startWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? weekRange.endWeek;
        const parsedLimit = parseOptionalInt(limit) ?? 200;
        const limitWasProvided = limit != null;

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        const allWallets = walletAddress
          ? null
          : filterLeaderboardWallets(await getAllImpactWallets());
        const wallets = walletAddress
          ? [walletAddress.toLowerCase()]
          : allWallets!.slice(0, parsedLimit);

        const results = await computeGlowImpactScores({
          walletAddresses: wallets,
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          includeWeeklyBreakdown: false,
        });

        if (walletAddress) {
          const match = results[0];
          if (!match) {
            set.status = 404;
            return "Wallet not found";
          }
          return match.glowWorth;
        }

        return {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          limit: parsedLimit,
          ...(!limitWasProvided
            ? { totalWalletCount: allWallets!.length }
            : {}),
          wallets: results.map((r) => r.glowWorth),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      query: t.Object({
        walletAddress: t.Optional(t.String({ pattern: "^0x[a-fA-F0-9]{40}$" })),
        startWeek: t.Optional(t.String()),
        endWeek: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get Glow Worth (GLW-denominated position)",
        description:
          "GlowWorth = LiquidGLW + DelegatedActiveGLW + UnclaimedGLWRewards. LiquidGLW is the current on-chain ERC20 balanceOf(wallet). DelegatedActiveGLW is the wallet’s share of remaining GLW protocol-deposit principal (vault ownership) computed from GLW-paid applications (principal) minus farm-level protocol-deposit rewards distributed (recovered), multiplied by the wallet’s depositSplitPercent6Decimals ownership. DelegatedActiveGLW also includes GLW launchpad purchases not yet reflected in Control API split history (prevents temporary dips when GLW moves into the vault). Unclaimed rewards are derived from Control API weekly rewards minus claim events from the claims API.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/delegators-leaderboard",
    async ({ query: { startWeek, endWeek, limit }, set }) => {
      try {
        const weekRange = getWeekRangeForImpact();
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? weekRange.startWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? weekRange.endWeek;
        const parsedLimit = parseOptionalInt(limit) ?? 200;

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        const cacheKey = [actualStartWeek, actualEndWeek, parsedLimit].join(
          ":"
        );
        const cached = readCachedDelegatorsLeaderboard(cacheKey);
        if (cached) return cached;

        const result = await computeDelegatorsLeaderboard({
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          limit: parsedLimit,
          excludeWallets: excludedLeaderboardWalletsSet,
        });

        const payload = {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          limit: parsedLimit,
          totalWalletCount: result.totalWalletCount,
          wallets: result.wallets,
        };

        delegatorsLeaderboardCache.set(cacheKey, {
          expiresAtMs: Date.now() + DELEGATORS_LEADERBOARD_CACHE_TTL_MS,
          data: payload,
        });

        return payload;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      query: t.Object({
        startWeek: t.Optional(t.String()),
        endWeek: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get Delegators Leaderboard",
        description:
          "Returns a delegators-only leaderboard using the vault (protocol-deposit principal recovery) model. Net rewards are computed as gross rewards earned (launchpad inflation + GLW protocol-deposit received) minus the wallet’s allocated principal released over the requested week range.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/wallet-stats",
    async ({ set }) => {
      try {
        const leaderboardRange = getWeekRangeForImpact();
        const wallets = await getLeaderboardWalletsForRange({
          startWeek: leaderboardRange.startWeek,
          endWeek: leaderboardRange.endWeek,
        });
        const totalWallets = wallets.length;

        const currentWeek = getCurrentEpoch();
        let delegators = 0;
        let miners = 0;

        if (wallets.length > 0) {
          const splitMap = await fetchDepositSplitsHistoryBatch({
            wallets,
            startWeek: leaderboardRange.startWeek,
            endWeek: currentWeek,
          });

          for (const [wallet, segments] of splitMap) {
            if (!wallet) continue;
            if (excludedLeaderboardWalletsSet.has(wallet.toLowerCase()))
              continue;
            const hasActiveShare = segments.some((seg) => {
              const splitScaled6 = BigInt(seg.depositSplitPercent6Decimals || "0");
              return (
                splitScaled6 > 0n &&
                currentWeek >= seg.startWeek &&
                currentWeek <= seg.endWeek
              );
            });
            if (hasActiveShare) delegators++;
          }

          const { walletToFarmTypes } =
            await getWalletPurchaseTypesByFarmUpToWeek({
              endWeek: currentWeek,
            });

          for (const wallet of wallets) {
            if (!wallet) continue;
            const farmTypes = walletToFarmTypes.get(wallet);
            if (!farmTypes) continue;
            let hasMiner = false;
            for (const types of farmTypes.values()) {
              if (types.has("mining-center")) {
                hasMiner = true;
                break;
              }
            }
            if (hasMiner) miners++;
          }
        }

        return {
          weekRange: {
            startWeek: leaderboardRange.startWeek,
            endWeek: leaderboardRange.endWeek,
          },
          totalWallets,
          delegators,
          miners,
          delegationWeek: currentWeek,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      detail: {
        summary: "Get wallet stats for the impact leaderboard",
        description:
          "Returns the current leaderboard wallet count (>= 0.01 points, excluding internal wallets) and the number of wallets with active vault ownership shares at the current protocol week.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/new-wallets-by-week",
    async ({ query: { startWeek, endWeek, includeWallets }, set }) => {
      try {
        const activityStartWeek = getWeekRangeForImpact().startWeek;
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? activityStartWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? getCurrentEpoch() - 1;
        const shouldIncludeWallets = parseOptionalBool(includeWallets);

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        const firstWeekByWallet = new Map<string, number>();

        const splitRows = await db
          .select({
            wallet: fractionSplits.buyer,
            firstTimestamp: sql<number>`min(${fractionSplits.timestamp})`,
          })
          .from(fractionSplits)
          .groupBy(fractionSplits.buyer);

        for (const row of splitRows) {
          const wallet = (row.wallet || "").toLowerCase();
          if (excludedLeaderboardWalletsSet.has(wallet)) continue;
          const ts = Number(row.firstTimestamp);
          if (!Number.isFinite(ts) || ts <= 0) continue;
          updateEarliestWeek(firstWeekByWallet, wallet, getCurrentEpoch(ts));
        }

        const rewardsHistoryRows = await db
          .select({
            createdAt: RewardsSplitsHistory.createdAt,
            rewardsSplits: RewardsSplitsHistory.rewardsSplits,
          })
          .from(RewardsSplitsHistory);

        for (const row of rewardsHistoryRows) {
          if (!row.createdAt) continue;
          const week = dateToEpoch(row.createdAt);
          let splits: Array<{ walletAddress?: string }> = [];
          if (Array.isArray(row.rewardsSplits)) {
            splits = row.rewardsSplits as Array<{ walletAddress?: string }>;
          } else if (typeof row.rewardsSplits === "string") {
            try {
              const parsed = JSON.parse(row.rewardsSplits) as Array<{
                walletAddress?: string;
              }>;
              if (Array.isArray(parsed)) splits = parsed;
            } catch {
              // ignore malformed JSON
            }
          }

          for (const split of splits) {
            const wallet = (split.walletAddress || "").toLowerCase();
            if (!wallet) continue;
            if (excludedLeaderboardWalletsSet.has(wallet)) continue;
            updateEarliestWeek(firstWeekByWallet, wallet, week);
          }
        }

        try {
          const glwHolders = await fetchNewGlwHoldersByWeek({
            startWeek: activityStartWeek,
            endWeek: actualEndWeek,
            minBalanceGlw: "0.01",
            includeWallets: true,
          });
          const holderWalletsByWeek = glwHolders.walletsByWeek || {};
          for (const [weekStr, wallets] of Object.entries(
            holderWalletsByWeek
          )) {
            const week = Number(weekStr);
            if (!Number.isFinite(week)) continue;
            for (const wallet of wallets) {
              const w = (wallet || "").toLowerCase();
              if (!w) continue;
              if (excludedLeaderboardWalletsSet.has(w)) continue;
              updateEarliestWeek(firstWeekByWallet, w, week);
            }
          }
        } catch {
          // skip GLW holders if ponder is unavailable
        }

        try {
          const gctlStakers = await fetchGctlStakersFromControlApi();
          const stakeCandidates = gctlStakers.stakers
            .map((w) => w.toLowerCase())
            .filter((w) => !excludedLeaderboardWalletsSet.has(w))
            .filter((w) => {
              const existing = firstWeekByWallet.get(w);
              return existing == null || existing > activityStartWeek;
            });

          if (stakeCandidates.length > 0) {
            const stakeMap = await getFirstStakeWeekByWallet({
              wallets: stakeCandidates,
              startWeek: activityStartWeek,
              endWeek: actualEndWeek,
              concurrency: 4,
            });
            for (const [wallet, week] of stakeMap) {
              if (excludedLeaderboardWalletsSet.has(wallet)) continue;
              updateEarliestWeek(firstWeekByWallet, wallet, week);
            }
          }
        } catch {
          // skip GCTL stake if Control API is unavailable
        }

        const byWeek: Record<number, number> = {};
        const walletsByWeek: Record<number, string[]> = {};
        for (let w = actualStartWeek; w <= actualEndWeek; w++) byWeek[w] = 0;

        for (const [wallet, week] of firstWeekByWallet) {
          if (week < actualStartWeek || week > actualEndWeek) continue;
          if (excludedLeaderboardWalletsSet.has(wallet)) continue;
          byWeek[week] = (byWeek[week] || 0) + 1;
          if (shouldIncludeWallets) {
            if (!walletsByWeek[week]) walletsByWeek[week] = [];
            walletsByWeek[week].push(wallet);
          }
        }

        return {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          byWeek,
          ...(shouldIncludeWallets
            ? {
                walletsByWeek: Object.fromEntries(
                  Object.entries(walletsByWeek).map(([week, list]) => [
                    week,
                    list.slice().sort(),
                  ])
                ),
              }
            : {}),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      query: t.Object({
        startWeek: t.Optional(t.String()),
        endWeek: t.Optional(t.String()),
        includeWallets: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get new wallets per week",
        description:
          "Returns a time series of the first protocol week a leaderboard-eligible wallet shows any protocol activity (fraction purchase, reward split, GCTL stake, or GLW balance). Uses protocol weeks and excludes internal/team wallets and sub-0.01 point wallets.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/new-glw-holders-by-week",
    async ({ query: { startWeek, endWeek, includeWallets, minBalanceGlw }, set }) => {
      try {
        const activityStartWeek = getWeekRangeForImpact().startWeek;
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? activityStartWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? getCurrentEpoch() - 1;
        const shouldIncludeWallets = parseOptionalBool(includeWallets);

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        const data = await fetchNewGlwHoldersByWeek({
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          minBalanceGlw: minBalanceGlw ?? "0.01",
          includeWallets: shouldIncludeWallets,
        });

        return data;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      query: t.Object({
        startWeek: t.Optional(t.String()),
        endWeek: t.Optional(t.String()),
        includeWallets: t.Optional(t.String()),
        minBalanceGlw: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get new GLW holders per week",
        description:
          "Returns a time series of the first protocol week a leaderboard-eligible wallet has a non-zero end-of-week GLW balance snapshot. Uses protocol weeks and excludes internal/team wallets and sub-0.01 point wallets.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/glow-score",
    async ({
      query: {
        walletAddress,
        startWeek,
        endWeek,
        limit,
        includeWeekly,
        debugTimings,
        sort,
        dir,
      },
      set,
    }) => {
      try {
        const requestStartMs = nowMs();
        const shouldLogTimings = parseOptionalBool(debugTimings);
        const requestId = shouldLogTimings ? createRequestId() : null;
        const timingEvents: Array<{
          label: string;
          ms: number;
          meta?: Record<string, unknown>;
        }> = [];
        const recordTiming = (evt: {
          label: string;
          ms: number;
          meta?: Record<string, unknown>;
        }) => {
          if (!shouldLogTimings) return;
          timingEvents.push(evt);
        };

        const weekRange = getWeekRangeForImpact();
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? weekRange.startWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? weekRange.endWeek;
        const parsedLimit = parseOptionalInt(limit) ?? 200;
        const limitWasProvided = limit != null;
        const shouldIncludeWeekly =
          includeWeekly === "true" || includeWeekly === "1";
        const isListMode = !walletAddress;
        const shouldLogTimingsForRequest = shouldLogTimings && isListMode;
        const sortKey =
          parseImpactLeaderboardSortKey(sort) ?? ("totalPoints" as const);
        const sortDir = parseSortDir(dir) ?? ("desc" as const);

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        if (isListMode) {
          if (sort && !parseImpactLeaderboardSortKey(sort)) {
            set.status = 400;
            return "sort must be one of: totalPoints, lastWeekPoints, glowWorth";
          }
          if (dir && !parseSortDir(dir)) {
            set.status = 400;
            return "dir must be one of: asc, desc";
          }
        }

        if (isListMode) {
          // Check if we can use the database cache (default week range)
          const isDefaultRange =
            (!startWeek || parseInt(startWeek) === weekRange.startWeek) &&
            (!endWeek || parseInt(endWeek) === weekRange.endWeek);

          if (isDefaultRange) {
            const sortCol =
              sortKey === "lastWeekPoints"
                ? impactLeaderboardCache.lastWeekPoints
                : sortKey === "glowWorth"
                ? impactLeaderboardCache.glowWorthWei
                : impactLeaderboardCache.totalPoints;

            const dbResults = await db
              .select({ data: impactLeaderboardCache.data })
              .from(impactLeaderboardCache)
              .where(
                and(
                  eq(impactLeaderboardCache.startWeek, actualStartWeek),
                  eq(impactLeaderboardCache.endWeek, actualEndWeek)
                )
              )
              .orderBy(sortDir === "asc" ? asc(sortCol) : desc(sortCol))
              .limit(parsedLimit);

            if (dbResults.length > 0) {
              const totalCountRes = await db
                .select({ count: sql<number>`count(*)` })
                .from(impactLeaderboardCache)
                .where(
                  and(
                    eq(impactLeaderboardCache.startWeek, actualStartWeek),
                    eq(impactLeaderboardCache.endWeek, actualEndWeek)
                  )
                );
              return {
                weekRange: {
                  startWeek: actualStartWeek,
                  endWeek: actualEndWeek,
                },
                limit: parsedLimit,
                totalWalletCount: Number(totalCountRes[0]?.count || 0),
                wallets: dbResults.map((r) => r.data),
              };
            }
          }

          const cacheKey = getGlowScoreListCacheKey({
            startWeek: actualStartWeek,
            endWeek: actualEndWeek,
            limit: parsedLimit,
            includeWeekly: shouldIncludeWeekly,
            limitWasProvided,
            sort: sortKey,
            dir: sortDir,
          });
          const cached = readCachedGlowScoreList(cacheKey);
          if (cached) {
            if (shouldLogTimingsForRequest) {
              console.log("[impact-score] leaderboard timings", {
                requestId,
                cached: true,
                weekRange: {
                  startWeek: actualStartWeek,
                  endWeek: actualEndWeek,
                },
                limit: parsedLimit,
                includeWeekly: shouldIncludeWeekly,
                sort: sortKey,
                dir: sortDir,
                msTotal: nowMs() - requestStartMs,
              });
            }
            return cached;
          }
        }

        const universeStartMs = nowMs();
        const universe = walletAddress
          ? null
          : await getImpactLeaderboardWalletUniverse({
              limit: parsedLimit,
              debug: shouldLogTimingsForRequest
                ? { requestId: requestId!, recordTiming }
                : undefined,
            });
        recordTiming({
          label: "router.universe.total",
          ms: nowMs() - universeStartMs,
          meta: universe
            ? {
                eligibleWallets: universe.eligibleWallets.length,
                candidateWallets: universe.candidateWallets.length,
              }
            : undefined,
        });
        const eligibleWalletCount = universe
          ? filterLeaderboardWallets(universe.eligibleWallets).length
          : 0;
        const gctlStakersSet = new Set(
          universe ? universe.gctlStakers.map((w) => w.toLowerCase()) : []
        );
        const wallets = walletAddress
          ? [walletAddress.toLowerCase()]
          : filterLeaderboardWallets(universe!.candidateWallets);

        const computeStartMs = nowMs();
        const results = await computeGlowImpactScores({
          walletAddresses: wallets,
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          includeWeeklyBreakdown: shouldIncludeWeekly,
          includeRegionBreakdown: !!walletAddress,
          debug: shouldLogTimingsForRequest
            ? { requestId: requestId!, recordTiming }
            : undefined,
        });
        recordTiming({
          label: "router.compute.total",
          ms: nowMs() - computeStartMs,
          meta: { wallets: wallets.length, results: results.length },
        });

        if (walletAddress) {
          const match = results[0];
          if (!match) {
            set.status = 404;
            return "Wallet not found";
          }
          const currentWeekProjection = await getCurrentWeekProjection(
            walletAddress.toLowerCase(),
            match.glowWorth
          );

          await populateReferralData(
            [match],
            actualEndWeek,
            new Map([[walletAddress.toLowerCase(), currentWeekProjection]])
          );
          return { ...match, currentWeekProjection };
        }

        function safePointsNumber(value: string | undefined): number {
          const num = Number(value);
          return Number.isFinite(num) ? num : 0;
        }

        function safePointsScaled6(value: string | undefined): bigint {
          if (!value) return 0n;
          const raw = value.trim();
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

        function safeBigInt(value: string | undefined): bigint {
          if (!value) return 0n;
          try {
            return BigInt(value);
          } catch {
            return 0n;
          }
        }

        const referralPointsByWallet = new Map<string, string>();
        const referralBonusByWallet = new Map<string, string>();
        if (results.length > 0) {
          const walletList = results.map((r) => r.walletAddress.toLowerCase());
          const [referrerRows, refereeRows] = await Promise.all([
            db
              .select({
                wallet: referralPointsWeekly.referrerWallet,
                totalPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
              })
              .from(referralPointsWeekly)
              .where(inArray(referralPointsWeekly.referrerWallet, walletList))
              .groupBy(referralPointsWeekly.referrerWallet),
            db
              .select({
                wallet: referralPointsWeekly.refereeWallet,
                referralBonusTotal: sql<string>`coalesce(sum(${referralPointsWeekly.refereeBonusPointsScaled6}), '0.000000')`,
                activationBonusTotal: sql<string>`coalesce(sum(${referralPointsWeekly.activationBonusPointsScaled6}), '0.000000')`,
              })
              .from(referralPointsWeekly)
              .where(inArray(referralPointsWeekly.refereeWallet, walletList))
              .groupBy(referralPointsWeekly.refereeWallet),
          ]);

          for (const row of referrerRows) {
            referralPointsByWallet.set(
              row.wallet.toLowerCase(),
              row.totalPoints
            );
          }

          for (const row of refereeRows) {
            const bonusTotal =
              safePointsScaled6(row.referralBonusTotal) +
              safePointsScaled6(row.activationBonusTotal);
            referralBonusByWallet.set(
              row.wallet.toLowerCase(),
              formatPointsScaled6(bonusTotal)
            );
          }

          for (const r of results) {
            const wallet = r.walletAddress.toLowerCase();
            const referralPointsScaled6 = safePointsScaled6(
              referralPointsByWallet.get(wallet)
            );
            const referralBonusPointsScaled6 = safePointsScaled6(
              referralBonusByWallet.get(wallet)
            );
            if (referralPointsScaled6 > 0n || referralBonusPointsScaled6 > 0n) {
              const baseTotal = safePointsScaled6(r.totals.totalPoints);
              r.totals.totalPoints = formatPointsScaled6(
                baseTotal + referralPointsScaled6 + referralBonusPointsScaled6
              );
            }
            r.composition.referralPoints = formatPointsScaled6(
              referralPointsScaled6
            );
            r.composition.referralBonusPoints = formatPointsScaled6(
              referralBonusPointsScaled6
            );
          }
        }

        function compareLeaderboardRows(
          a: {
            walletAddress: string;
            totalPoints: string;
            lastWeekPoints: string;
            glowWorthWei: string;
          },
          b: {
            walletAddress: string;
            totalPoints: string;
            lastWeekPoints: string;
            glowWorthWei: string;
          },
          params: { sort: ImpactLeaderboardSortKey; dir: SortDir }
        ) {
          const factor = params.dir === "asc" ? 1 : -1;
          if (params.sort === "glowWorth") {
            const av = safeBigInt(a.glowWorthWei);
            const bv = safeBigInt(b.glowWorthWei);
            if (av !== bv) return av > bv ? factor : -factor;
          } else {
            const av =
              params.sort === "lastWeekPoints"
                ? safePointsScaled6(a.lastWeekPoints)
                : safePointsScaled6(a.totalPoints);
            const bv =
              params.sort === "lastWeekPoints"
                ? safePointsScaled6(b.lastWeekPoints)
                : safePointsScaled6(b.totalPoints);
            if (av !== bv) return av > bv ? factor : -factor;
          }

          // Deterministic tie-breaker (keeps globalRank stable across runs even on ties).
          const wa = (a.walletAddress || "").toLowerCase();
          const wb = (b.walletAddress || "").toLowerCase();
          if (wa === wb) return 0;
          return wa > wb ? 1 : -1;
        }

        const payload = {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          limit: parsedLimit,
          totalWalletCount: eligibleWalletCount,
          wallets: results.map((r) => {
            const hadSteeringAtEndWeek = (() => {
              try {
                const totalSteeringGlwWei = BigInt(
                  r.totals?.totalSteeringGlwWei || "0"
                );
                return totalSteeringGlwWei > 0n;
              } catch {
                return false;
              }
            })();

            return {
              walletAddress: r.walletAddress,
              totalPoints: r.totals.totalPoints,
              glowWorthWei: r.glowWorth.glowWorthWei,
              composition: r.composition,
              lastWeekPoints: r.lastWeekPoints,
              activeMultiplier: r.activeMultiplier,
              hasMinerMultiplier: r.hasMinerMultiplier,
              hasSteeringStake: hadSteeringAtEndWeek,
              hasVaultBonus: (() => {
                try {
                  return BigInt(r.glowWorth.delegatedActiveGlwWei || "0") > 0n;
                } catch {
                  return false;
                }
              })(),
              hasReferralPoints: parseFloat(r.composition.referralPoints || "0") > 0,
              referralPointsScaled6: r.composition.referralPoints || "0.000000",
              endWeekMultiplier: r.endWeekMultiplier,
              globalRank: 0,
            };
          }),
        };

        // globalRank is always defined as totalPoints-desc rank (stable across sorts).
        const globalRankByWallet = new Map<string, number>();
        payload.wallets
          .slice()
          .sort((a, b) =>
            compareLeaderboardRows(a, b, { sort: "totalPoints", dir: "desc" })
          )
          .forEach((row, idx) =>
            globalRankByWallet.set(row.walletAddress.toLowerCase(), idx + 1)
          );
        payload.wallets.forEach((row) => {
          row.globalRank =
            globalRankByWallet.get(row.walletAddress.toLowerCase()) ?? 0;
        });

        // Sort requested key/dir before slicing to limit.
        payload.wallets.sort((a, b) =>
          compareLeaderboardRows(a, b, { sort: sortKey, dir: sortDir })
        );
        payload.wallets = payload.wallets.slice(0, parsedLimit);

        const cacheKey = getGlowScoreListCacheKey({
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          limit: parsedLimit,
          includeWeekly: shouldIncludeWeekly,
          limitWasProvided,
          sort: sortKey,
          dir: sortDir,
        });
        glowScoreListCache.set(cacheKey, {
          expiresAtMs: Date.now() + GLOW_SCORE_LIST_CACHE_TTL_MS,
          data: payload,
        });

        if (shouldLogTimingsForRequest) {
          const msTotal = nowMs() - requestStartMs;
          timingEvents.push({
            label: "router.total",
            ms: msTotal,
            meta: { cached: false },
          });
          console.log("[impact-score] leaderboard timings", {
            requestId,
            cached: false,
            weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
            limit: parsedLimit,
            includeWeekly: shouldIncludeWeekly,
            sort: sortKey,
            dir: sortDir,
            walletsRequested: wallets.length,
            walletsReturned: payload.wallets.length,
            totalWalletCount: !limitWasProvided
              ? eligibleWalletCount
              : undefined,
            timings: timingEvents
              .slice()
              .sort((a, b) => b.ms - a.ms)
              .map((t) => ({
                label: t.label,
                ms: Math.round(t.ms * 10) / 10,
                ...(t.meta ? { meta: t.meta } : {}),
              })),
            msTotal: Math.round(msTotal * 10) / 10,
          });
        }

        return payload;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Error Occurred";
      }
    },
    {
      query: t.Object({
        walletAddress: t.Optional(t.String({ pattern: "^0x[a-fA-F0-9]{40}$" })),
        startWeek: t.Optional(t.String()),
        endWeek: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        includeWeekly: t.Optional(t.String()),
        debugTimings: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        dir: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get Glow Impact Score",
        description:
          "Computes weekly rollover points (emissions + steering + vault bonus) with a total multiplier (base cash-miner multiplier + impact streak bonus). The streak bonus increases on weeks where delegated GLW increases or the wallet buys a mining-center fraction that week. Also includes continuous GlowWorth accrual. For continuous points, LiquidGLW uses end-of-week balance snapshots (point-in-time) with fallback to the current on-chain balance if snapshots are missing. GCTL steering is derived from Control API stake-by-epoch; if unavailable it falls back to the current stake snapshot.",
        tags: [TAG.REWARDS],
      },
    }
  );
