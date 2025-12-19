import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { getWeekRange } from "../fractions-router/helpers/apy-helpers";
import {
  computeGlowImpactScores,
  getAllImpactWallets,
} from "./helpers/impact-score";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

        const allWallets = walletAddress ? null : await getAllImpactWallets();
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
          "GlowWorth = LiquidGLW + DelegatedActiveGLW + UnclaimedGLWRewards. DelegatedActiveGLW is computed as delegated launchpad GLW minus recovered protocol-deposit rewards (converted to GLW using spot price). Unclaimed rewards are mocked until Control API endpoint is available.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/glow-score",
    async ({
      query: { walletAddress, startWeek, endWeek, limit, includeWeekly },
      set,
    }) => {
      try {
        const weekRange = getWeekRange();
        const actualStartWeek =
          parseOptionalInt(startWeek) ?? weekRange.startWeek;
        const actualEndWeek = parseOptionalInt(endWeek) ?? weekRange.endWeek;
        const parsedLimit = parseOptionalInt(limit) ?? 200;
        const limitWasProvided = limit != null;
        const shouldIncludeWeekly =
          includeWeekly === "true" || includeWeekly === "1" || !!walletAddress;

        if (actualEndWeek < actualStartWeek) {
          set.status = 400;
          return "endWeek must be >= startWeek";
        }

        const allWallets = walletAddress ? null : await getAllImpactWallets();
        const wallets = walletAddress
          ? [walletAddress.toLowerCase()]
          : allWallets!.slice(0, parsedLimit);

        const results = await computeGlowImpactScores({
          walletAddresses: wallets,
          startWeek: actualStartWeek,
          endWeek: actualEndWeek,
          includeWeeklyBreakdown: shouldIncludeWeekly,
        });

        if (walletAddress) {
          const match = results[0];
          if (!match) {
            set.status = 404;
            return "Wallet not found";
          }
          return match;
        }

        return {
          weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
          limit: parsedLimit,
          ...(!limitWasProvided
            ? { totalWalletCount: allWallets!.length }
            : {}),
          wallets: results
            .map((r) => ({
              walletAddress: r.walletAddress,
              totalPoints: r.totals.totalPoints,
              glowWorthWei: r.glowWorth.glowWorthWei,
            }))
            .sort((a, b) => Number(b.totalPoints) - Number(a.totalPoints)),
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
        includeWeekly: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get Glow Impact Score",
        description:
          "Computes weekly rollover points (inflation + steering + vault bonus) with cash-miner multiplier, plus continuous GlowWorth accrual. GCTL steering is derived from Control API stakedControl. Unclaimed rewards are mocked until Control API endpoint is available.",
        tags: [TAG.REWARDS],
      },
    }
  );
