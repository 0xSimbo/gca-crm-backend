import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { getWeekRange } from "../fractions-router/helpers/apy-helpers";
import {
  computeDelegatorsLeaderboard,
  computeGlowImpactScores,
  getCurrentWeekProjection,
  getAllImpactWallets,
  getImpactLeaderboardWalletUniverse,
} from "./helpers/impact-score";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
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

/**
 * Wallets we control (team/treasury/test wallets) that must not appear in user leaderboards.
 * Keep these lowercased.
 */
const EXCLUDED_LEADERBOARD_WALLETS = [
  "0x6972B05A0c80064fBE8a10CBc2a2FBCF6fb47D6a",
  "0x0b650820dde452b204de44885fc0fbb788fc5e37",
].map((w) => w.toLowerCase());

const excludedLeaderboardWalletsSet = new Set(EXCLUDED_LEADERBOARD_WALLETS);

function filterLeaderboardWallets(wallets: string[]): string[] {
  return wallets.filter((w) => !excludedLeaderboardWalletsSet.has(w));
}

function getGlowScoreListCacheKey(params: {
  startWeek: number;
  endWeek: number;
  limit: number;
  includeWeekly: boolean;
  limitWasProvided: boolean;
}): string {
  return [
    params.startWeek,
    params.endWeek,
    params.limit,
    params.includeWeekly ? 1 : 0,
    params.limitWasProvided ? 1 : 0,
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

export const impactRouter = new Elysia({ prefix: "/impact" })
  .get(
    "/glow-worth",
    async ({ query: { walletAddress, startWeek, endWeek, limit }, set }) => {
      try {
        const weekRange = getWeekRange();
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
          "GlowWorth = LiquidGLW + DelegatedActiveGLW + UnclaimedGLWRewards. LiquidGLW is the current on-chain ERC20 balanceOf(wallet). DelegatedActiveGLW is the wallet’s share of remaining GLW protocol-deposit principal (vault ownership) computed from GLW-paid applications (principal) minus farm-level protocol-deposit rewards distributed (recovered), multiplied by the wallet’s depositSplitPercent6Decimals ownership. Unclaimed rewards are derived from Control API weekly rewards minus claim events from the claims API.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/delegators-leaderboard",
    async ({ query: { startWeek, endWeek, limit }, set }) => {
      try {
        const weekRange = getWeekRange();
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
    "/glow-score",
    async ({
      query: {
        walletAddress,
        startWeek,
        endWeek,
        limit,
        includeWeekly,
        debugTimings,
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

        const weekRange = getWeekRange();
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? weekRange.startWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? weekRange.endWeek;
        const parsedLimit = parseOptionalInt(limit) ?? 200;
        const limitWasProvided = limit != null;
        const shouldIncludeWeekly =
          includeWeekly === "true" || includeWeekly === "1" || !!walletAddress;
        const isListMode = !walletAddress;
        const shouldLogTimingsForRequest = shouldLogTimings && isListMode;

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        if (isListMode) {
          const cacheKey = getGlowScoreListCacheKey({
            startWeek: actualStartWeek,
            endWeek: actualEndWeek,
            limit: parsedLimit,
            includeWeekly: shouldIncludeWeekly,
            limitWasProvided,
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
        const wallets = walletAddress
          ? [walletAddress.toLowerCase()]
          : filterLeaderboardWallets(universe!.candidateWallets);

        const computeStartMs = nowMs();
        const results = await computeGlowImpactScores({
          walletAddresses: wallets,
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          includeWeeklyBreakdown: shouldIncludeWeekly,
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
          return { ...match, currentWeekProjection };
        }

        const payload = {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          limit: parsedLimit,
          ...(!limitWasProvided
            ? { totalWalletCount: eligibleWalletCount }
            : {}),
          wallets: results
            .map((r) => ({
              walletAddress: r.walletAddress,
              totalPoints: r.totals.totalPoints,
              glowWorthWei: r.glowWorth.glowWorthWei,
              composition: r.composition,
              lastWeekPoints: r.lastWeekPoints,
              activeMultiplier: r.activeMultiplier,
              endWeekMultiplier: r.endWeekMultiplier,
            }))
            .sort((a, b) => Number(b.totalPoints) - Number(a.totalPoints)),
        };
        payload.wallets = payload.wallets.slice(0, parsedLimit);
        const cacheKey = getGlowScoreListCacheKey({
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          limit: parsedLimit,
          includeWeekly: shouldIncludeWeekly,
          limitWasProvided,
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
      }),
      detail: {
        summary: "Get Glow Impact Score",
        description:
          "Computes weekly rollover points (emissions + steering + vault bonus) with a total multiplier (base cash-miner multiplier + impact streak bonus), plus continuous GlowWorth accrual. For continuous points, LiquidGLW uses a per-week time-weighted average balance (TWAB) derived from indexed ERC20 Transfer history (ponder listener). GCTL steering is derived from Control API stake-by-epoch; if unavailable it falls back to the current stake snapshot.",
        tags: [TAG.REWARDS],
      },
    }
  );
