import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/db";
import {
  fmiWeeklyInputs,
  gctlStakedByRegionWeek,
  polRevenueByFarmWeek,
  polRevenueByRegionWeek,
  polYieldWeek,
} from "../../src/db/schema";
import { polRouter } from "../../src/routers/pol-router/polRouter";
import { fmiRouter } from "../../src/routers/fmi-router/fmiRouter";
import { glwRouter } from "../../src/routers/glw-router/glwRouter";
import { GENESIS_TIMESTAMP } from "../../src/constants/genesis-timestamp";
import { lqAtomicToUsdUsdc6 } from "../../src/pol/math/usdLq";

const app = new Elysia().use(polRouter).use(fmiRouter).use(glwRouter);

function withFrozenNow<T>(unixSeconds: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => unixSeconds * 1000;
  return fn().finally(() => {
    Date.now = original;
  });
}

describe("PoL Dashboard: endpoint integration-ish", () => {
  // Use a deterministic completed week in tests.
  // Use far-future weeks/dates to avoid colliding with real data in a shared dev DB.
  const completedWeek = 9_999;
  const nowUnixSeconds = GENESIS_TIMESTAMP + (completedWeek + 1) * 604800 + 123;
  const testZoneId = 9_999;
  const testFarmId = "00000000-0000-0000-0000-00000000f001";
  const testWeeks = [completedWeek - 1, completedWeek];

  beforeEach(async () => {
    // Targeted cleanup only for rows inserted by these tests.
    await db
      .delete(polRevenueByRegionWeek)
      .where(
        and(
          inArray(polRevenueByRegionWeek.weekNumber, testWeeks),
          eq(polRevenueByRegionWeek.region, String(testZoneId))
        )
      );
    await db
      .delete(polYieldWeek)
      .where(eq(polYieldWeek.weekNumber, completedWeek));
    await db
      .delete(fmiWeeklyInputs)
      .where(eq(fmiWeeklyInputs.weekNumber, completedWeek));
    await db
      .delete(gctlStakedByRegionWeek)
      .where(
        and(
          inArray(gctlStakedByRegionWeek.weekNumber, testWeeks),
          eq(gctlStakedByRegionWeek.region, String(testZoneId))
        )
      );
    await db
      .delete(polRevenueByFarmWeek)
      .where(
        and(
          inArray(polRevenueByFarmWeek.weekNumber, testWeeks),
          eq(polRevenueByFarmWeek.farmId, testFarmId)
        )
      );
  });

  afterEach(async () => {
    // Same targeted cleanup after each test to keep reruns stable.
    await db
      .delete(polRevenueByRegionWeek)
      .where(
        and(
          inArray(polRevenueByRegionWeek.weekNumber, testWeeks),
          eq(polRevenueByRegionWeek.region, String(testZoneId))
        )
      );
    await db
      .delete(polYieldWeek)
      .where(eq(polYieldWeek.weekNumber, completedWeek));
    await db
      .delete(fmiWeeklyInputs)
      .where(eq(fmiWeeklyInputs.weekNumber, completedWeek));
    await db
      .delete(gctlStakedByRegionWeek)
      .where(
        and(
          inArray(gctlStakedByRegionWeek.weekNumber, testWeeks),
          eq(gctlStakedByRegionWeek.region, String(testZoneId))
        )
      );
    await db
      .delete(polRevenueByFarmWeek)
      .where(
        and(
          inArray(polRevenueByFarmWeek.weekNumber, testWeeks),
          eq(polRevenueByFarmWeek.farmId, testFarmId)
        )
      );
  });

  it("GET /glw/vesting-schedule returns rows ordered by date", async () => {
    const res = await app.handle(new Request("http://localhost/glw/vesting-schedule"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(0);
    // Ensure sorted by date.
    for (let i = 1; i < json.length; i++) {
      expect(String(json[i - 1].date) <= String(json[i].date)).toBe(true);
    }
    // Basic shape: unlocked is an integer string.
    expect(typeof json[0].date).toBe("string");
    expect(typeof json[0].unlocked).toBe("string");
    expect(/^\d+$/.test(json[0].unlocked)).toBe(true);
  });

  it("GET /fmi/pressure returns latest completed week snapshot", async () => {
    await db.insert(fmiWeeklyInputs).values({
      weekNumber: completedWeek,
      minerSalesUsd: "100",
      gctlMintsUsd: "200",
      polYieldUsd: "300",
      dexSellPressureUsd: "50",
      buyPressureUsd: "600",
      sellPressureUsd: "50",
      netUsd: "550",
      buySellRatio: "12",
      indexingComplete: true,
      computedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(new Request("http://localhost/fmi/pressure?range=7d"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.week).toBe(completedWeek);
      expect(json.buy_pressure).toBe("600");
      expect(json.dex_sell_pressure_weekly_usd).toBe("50");
    });
  });

  it("GET /pol/revenue/aggregate uses snapshots for revenue + yield + active farm count", async () => {
    await db.insert(polRevenueByRegionWeek).values([
      { weekNumber: completedWeek - 1, region: String(testZoneId), totalLq: "100", minerSalesLq: "100", gctlMintsLq: "0" },
      { weekNumber: completedWeek, region: String(testZoneId), totalLq: "200", minerSalesLq: "0", gctlMintsLq: "200" },
    ]);

    await db.insert(polYieldWeek).values({
      weekNumber: completedWeek,
      strategyReturns90dLq: "10",
      uniFees90dLq: "5",
      polStartLq: "0",
      apy: "0.12",
      yieldPerWeekLq: "1",
      indexingComplete: true,
      fetchedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(new Request("http://localhost/pol/revenue/aggregate?range=90d"));
      expect(res.status).toBe(200);
      const json = await res.json();
      // lifetime includes all historical rows (might include preexisting dev DB data), but range should be isolated to the far-future window.
      expect(BigInt(json.lifetime_lq)).toBeGreaterThanOrEqual(300n);
      expect(json.ninety_day_yield_lq).toBe("15");
      // The test database may have existing applications; just validate the field shape.
      expect(typeof json.active_farms).toBe("number");
      expect(json.active_farms).toBeGreaterThanOrEqual(0);
    });
  });

  it("GET /pol/revenue/aggregate/series returns weekly aggregate buckets", async () => {
    await db.insert(polRevenueByRegionWeek).values({
      weekNumber: completedWeek,
      region: String(testZoneId),
      totalLq: "200",
      minerSalesLq: "50",
      gctlMintsLq: "120",
      polYieldLq: "30",
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(
        new Request("http://localhost/pol/revenue/aggregate/series?range=7d")
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.range).toBe("7d");
      expect(json.weekRange.startWeek).toBe(completedWeek);
      expect(json.weekRange.endWeek).toBe(completedWeek);
      expect(Array.isArray(json.series)).toBe(true);
      expect(json.series.length).toBe(1);

      const row = json.series[0];
      expect(row.week).toBe(completedWeek);
      expect(row.week_start_timestamp).toBe(
        GENESIS_TIMESTAMP + completedWeek * 604800
      );
      expect(row.week_end_timestamp).toBe(
        GENESIS_TIMESTAMP + (completedWeek + 1) * 604800
      );
      expect(BigInt(row.total_lq)).toBeGreaterThanOrEqual(200n);
      expect(BigInt(row.miner_sales_lq)).toBeGreaterThanOrEqual(50n);
      expect(BigInt(row.gctl_mints_lq)).toBeGreaterThanOrEqual(120n);
      expect(BigInt(row.pol_yield_lq)).toBeGreaterThanOrEqual(30n);
    });
  });

  it("GET /pol/revenue/regions/series returns per-region weekly buckets", async () => {
    await db.insert(polRevenueByRegionWeek).values({
      weekNumber: completedWeek,
      region: String(testZoneId),
      totalLq: "200",
      minerSalesLq: "50",
      gctlMintsLq: "120",
      polYieldLq: "30",
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(
        new Request("http://localhost/pol/revenue/regions/series?range=7d")
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.range).toBe("7d");
      expect(json.weekRange.startWeek).toBe(completedWeek);
      expect(json.weekRange.endWeek).toBe(completedWeek);
      expect(Array.isArray(json.regions)).toBe(true);

      const region = json.regions.find((r: any) => r.zone_id === testZoneId);
      expect(region).toBeTruthy();
      expect(Array.isArray(region.series)).toBe(true);
      expect(region.series.length).toBe(1);
      expect(BigInt(region.series[0].total_lq)).toBeGreaterThanOrEqual(200n);
      expect(BigInt(region.series[0].miner_sales_lq)).toBeGreaterThanOrEqual(50n);
      expect(BigInt(region.series[0].gctl_mints_lq)).toBeGreaterThanOrEqual(120n);
      expect(BigInt(region.series[0].pol_yield_lq)).toBeGreaterThanOrEqual(30n);
    });
  });

  it("GET /pol/revenue/farms/:farmId/series returns weekly buckets for a farm", async () => {
    await db.insert(polRevenueByFarmWeek).values({
      weekNumber: completedWeek,
      farmId: testFarmId,
      totalLq: "200",
      minerSalesLq: "50",
      gctlMintsLq: "120",
      polYieldLq: "30",
      computedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(
        new Request(
          `http://localhost/pol/revenue/farms/${testFarmId}/series?range=7d`
        )
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.range).toBe("7d");
      expect(json.farm_id).toBe(testFarmId);
      expect(json.weekRange.startWeek).toBe(completedWeek);
      expect(json.weekRange.endWeek).toBe(completedWeek);
      expect(Array.isArray(json.series)).toBe(true);
      expect(json.series.length).toBe(1);
      expect(BigInt(json.series[0].total_lq)).toBeGreaterThanOrEqual(200n);
      expect(BigInt(json.series[0].miner_sales_lq)).toBeGreaterThanOrEqual(50n);
      expect(BigInt(json.series[0].gctl_mints_lq)).toBeGreaterThanOrEqual(120n);
      expect(BigInt(json.series[0].pol_yield_lq)).toBeGreaterThanOrEqual(30n);
    });
  });

  it("GET /pol/revenue/farms/series returns per-farm weekly buckets", async () => {
    await db.insert(polRevenueByFarmWeek).values({
      weekNumber: completedWeek,
      farmId: testFarmId,
      totalLq: "200",
      minerSalesLq: "50",
      gctlMintsLq: "120",
      polYieldLq: "30",
      computedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(
        new Request("http://localhost/pol/revenue/farms/series?range=7d")
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.range).toBe("7d");
      expect(json.weekRange.startWeek).toBe(completedWeek);
      expect(json.weekRange.endWeek).toBe(completedWeek);
      expect(Array.isArray(json.farms)).toBe(true);

      const farm = json.farms.find((f: any) => f.farm_id === testFarmId);
      expect(farm).toBeTruthy();
      expect(Array.isArray(farm.series)).toBe(true);
      expect(farm.series.length).toBe(1);
      expect(BigInt(farm.series[0].total_lq)).toBeGreaterThanOrEqual(200n);
      expect(BigInt(farm.series[0].miner_sales_lq)).toBeGreaterThanOrEqual(50n);
      expect(BigInt(farm.series[0].gctl_mints_lq)).toBeGreaterThanOrEqual(120n);
      expect(BigInt(farm.series[0].pol_yield_lq)).toBeGreaterThanOrEqual(30n);
    });
  });

  it("GET /pol/revenue/regions returns zone aggregates and staked_gctl for latest week", async () => {
    await db.insert(polRevenueByRegionWeek).values([
      { weekNumber: completedWeek, region: String(testZoneId), totalLq: "200", minerSalesLq: "0", gctlMintsLq: "200" },
    ]);
    await db.insert(gctlStakedByRegionWeek).values({
      weekNumber: completedWeek,
      region: String(testZoneId),
      gctlStakedRaw: "123",
      fetchedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(new Request("http://localhost/pol/revenue/regions?range=90d"));
      expect(res.status).toBe(200);
      const json = await res.json();
      const row = json.find((r: any) => r.zone_id === testZoneId);
      expect(row).toBeTruthy();
      expect(row.staked_gctl).toBe("123");
    });
  });

  it("GET /pol/revenue/regions falls back to latest available stake snapshot week when current week is missing", async () => {
    await db.insert(polRevenueByRegionWeek).values([
      { weekNumber: completedWeek, region: String(testZoneId), totalLq: "200", minerSalesLq: "0", gctlMintsLq: "200" },
    ]);

    // Insert stake for the previous week only.
    await db.insert(gctlStakedByRegionWeek).values({
      weekNumber: completedWeek - 1,
      region: String(testZoneId),
      gctlStakedRaw: "456",
      fetchedAt: new Date(),
    });

    await withFrozenNow(nowUnixSeconds, async () => {
      const res = await app.handle(new Request("http://localhost/pol/revenue/regions?range=90d"));
      expect(res.status).toBe(200);
      const json = await res.json();
      const row = json.find((r: any) => r.zone_id === testZoneId);
      expect(row).toBeTruthy();
      expect(row.staked_gctl).toBe("456");
    });
  });

  it("GET /pol/liquidity returns weekly series derived from ponder /pol/points", async () => {
    const originalFetch = globalThis.fetch;
    process.env.CLAIMS_API_BASE_URL = "http://ponder.local";

    try {
      await withFrozenNow(nowUnixSeconds, async () => {
        const endWeek = completedWeek;
        const startWeek = completedWeek - 2;

        const weekEnd0 = GENESIS_TIMESTAMP + (startWeek + 1) * 604800;
        const weekEnd1 = GENESIS_TIMESTAMP + (startWeek + 2) * 604800;
        const weekEnd2 = GENESIS_TIMESTAMP + (startWeek + 3) * 604800;

        const spot = "4"; // USDG per GLW
        const p0 = {
          timestamp: String(weekEnd0 - 10),
          week: startWeek,
          blockNumber: "1",
          logIndex: "0",
          spotPrice: spot,
          endowment: { lpBalance: "0", totalLpSupply: "0", usdg: "0", glw: "0", lq: "1000" },
          botActive: { timestamp: null, tradeType: null, usdg: "0", glw: "0", lq: "2000" },
          total: { usdg: "0", glw: "0", lq: "3000" },
        };
        const p1 = {
          ...p0,
          timestamp: String(weekEnd1 - 10),
          week: startWeek + 1,
          endowment: { ...p0.endowment, lq: "2000" },
          botActive: { ...p0.botActive, lq: "3000" },
          total: { ...p0.total, lq: "5000" },
        };
        const p2 = {
          ...p0,
          timestamp: String(weekEnd2 - 10),
          week: startWeek + 2,
          endowment: { ...p0.endowment, lq: "4000" },
          botActive: { ...p0.botActive, lq: "4000" },
          total: { ...p0.total, lq: "8000" },
        };

        globalThis.fetch = async (input: any, init?: any) => {
          const url = String(input);
          if (!url.startsWith("http://ponder.local/pol/points?")) {
            return await originalFetch(input, init);
          }
          const body = {
            from: weekEnd0 - 604800,
            to: weekEnd2,
            range: null,
            interval: "hour",
            points: [p0, p1, p2],
            indexingComplete: true,
          };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };

        const res = await app.handle(
          new Request("http://localhost/pol/liquidity?range=3w")
        );
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json.weekRange.startWeek).toBe(startWeek);
        expect(json.weekRange.endWeek).toBe(endWeek);
        expect(json.series.length).toBe(3);

        const last = json.series[2];
        expect(last.weekNumber).toBe(endWeek);
        expect(last.totalLq).toBe("8000");

        const expectedUsd = lqAtomicToUsdUsdc6({
          lqAtomic: 8000n,
          spotPriceUsdgPerGlw: spot,
        }).toString();
        expect(last.totalUsdUsdc6).toBe(expectedUsd);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
