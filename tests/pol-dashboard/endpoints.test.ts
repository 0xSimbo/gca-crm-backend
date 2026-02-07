import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/db";
import {
  fmiWeeklyInputs,
  gctlStakedByRegionWeek,
  polRevenueByRegionWeek,
  polYieldWeek,
} from "../../src/db/schema";
import { polRouter } from "../../src/routers/pol-router/polRouter";
import { fmiRouter } from "../../src/routers/fmi-router/fmiRouter";
import { glwRouter } from "../../src/routers/glw-router/glwRouter";
import { GENESIS_TIMESTAMP } from "../../src/constants/genesis-timestamp";

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
          eq(gctlStakedByRegionWeek.weekNumber, completedWeek),
          eq(gctlStakedByRegionWeek.region, String(testZoneId))
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
          eq(gctlStakedByRegionWeek.weekNumber, completedWeek),
          eq(gctlStakedByRegionWeek.region, String(testZoneId))
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
});
