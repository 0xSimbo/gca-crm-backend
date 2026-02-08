import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../src/db/db";
import { impactLeaderboardCache } from "../../src/db/schema";
import { GENESIS_TIMESTAMP } from "../../src/constants/genesis-timestamp";
import { excludedLeaderboardWalletsSet } from "../../src/constants/excluded-wallets";

const { impactRouter } = await import("../../src/routers/impact-router/impactRouter");

function makeTestWallet(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function withFrozenNow<T>(unixSeconds: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => unixSeconds * 1000;
  return fn().finally(() => {
    Date.now = original;
  });
}

describe("Impact: /wallet-stats cache fallback", () => {
  const app = new Elysia().use(impactRouter);
  const startWeek = 97;
  const requestedEndWeek = 115;
  const cachedEndWeek = 114;
  const currentWeek = requestedEndWeek + 1;
  const nowUnixSeconds = GENESIS_TIMESTAMP + currentWeek * 604800 + 123;

  let wallets: string[] = [];
  let originalFetch: typeof fetch | null = null;
  let originalControlApiUrl: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalControlApiUrl = process.env.CONTROL_API_URL;
    process.env.CONTROL_API_URL = "http://__test_control_api__";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? "");
      if (
        url.startsWith("http://__test_control_api__/farms/by-wallet/deposit-splits-history/batch")
      ) {
        return new Response(JSON.stringify({ results: {} }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as any;

    wallets = [makeTestWallet(), makeTestWallet(), makeTestWallet()];
    await db.insert(impactLeaderboardCache).values(
      wallets.map((w, i) => ({
        walletAddress: w.toLowerCase(),
        totalPoints: "1.000000",
        lastWeekPoints: "0.500000",
        glowWorthWei: "0",
        rank: i + 1,
        startWeek,
        endWeek: cachedEndWeek,
        data: { walletAddress: w.toLowerCase(), totalPoints: "1.000000" },
        updatedAt: new Date(),
      }))
    );
  });

  afterEach(async () => {
    const ids = wallets.map((w) => w.toLowerCase());
    if (ids.length === 0) return;
    await db.delete(impactLeaderboardCache).where(inArray(impactLeaderboardCache.walletAddress, ids));

    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalControlApiUrl === undefined) {
      delete process.env.CONTROL_API_URL;
    } else {
      process.env.CONTROL_API_URL = originalControlApiUrl;
    }
  });

  it("falls back to latest cached endWeek <= requested endWeek", async () => {
    await withFrozenNow(nowUnixSeconds, async () => {
      // Because the dev DB can contain rows outside this test, derive the expected
      // endWeek using the same fallback logic as the router.
      const exactRows = await db
        .select({
          wallet: impactLeaderboardCache.walletAddress,
          totalPoints: impactLeaderboardCache.totalPoints,
        })
        .from(impactLeaderboardCache)
        .where(
          and(
            eq(impactLeaderboardCache.startWeek, startWeek),
            eq(impactLeaderboardCache.endWeek, requestedEndWeek)
          )
        );

      let expectedEndWeekUsed = requestedEndWeek;
      if (exactRows.length === 0) {
        const maxRes = await db
          .select({ maxEnd: sql<number>`max(${impactLeaderboardCache.endWeek})` })
          .from(impactLeaderboardCache)
          .where(
            and(
              eq(impactLeaderboardCache.startWeek, startWeek),
              lte(impactLeaderboardCache.endWeek, requestedEndWeek)
            )
          );
        const maxEndRaw = (maxRes[0] as any)?.maxEnd;
        const maxEnd = maxEndRaw == null ? null : Number(maxEndRaw);
        if (maxEnd != null && Number.isFinite(maxEnd)) expectedEndWeekUsed = maxEnd;
      }

      const expectedRows = await db
        .select({
          wallet: impactLeaderboardCache.walletAddress,
          totalPoints: impactLeaderboardCache.totalPoints,
        })
        .from(impactLeaderboardCache)
        .where(
          and(
            eq(impactLeaderboardCache.startWeek, startWeek),
            eq(impactLeaderboardCache.endWeek, expectedEndWeekUsed)
          )
        );
      // Expected count uses the same >=0.01 threshold + excluded wallet filter as the router.
      const expectedForEndWeek = expectedRows
        .filter((r: any) => Number(r?.totalPoints) >= 0.01)
        .filter((r: any) => !excludedLeaderboardWalletsSet.has(String(r.wallet || "").toLowerCase()))
        .length;

      const res = await app.handle(new Request("http://localhost/impact/wallet-stats"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.weekRange.startWeek).toBe(startWeek);
      expect(json.weekRange.endWeek).toBe(expectedEndWeekUsed);
      expect(json.totalWallets).toBe(expectedForEndWeek);
      expect(json.delegationWeek).toBe(currentWeek);
    });
  });
});
