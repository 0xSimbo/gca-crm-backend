import { Elysia, t } from "elysia";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { TAG } from "../../constants";
import { db } from "../../db/db";
import {
  applications,
  applicationsAuditFieldsCRS,
  Documents,
  farms,
  gctlStakedByRegionWeek,
  polRevenueByFarmWeek,
  polRevenueByRegionWeek,
  polYieldWeek,
} from "../../db/schema";
import { Decimal } from "../../pol/math/decimal";
import { getCompletedWeekNumber, getProtocolWeekForTimestamp } from "../../pol/protocolWeeks";
import { fetchPonderPolYield } from "../../pol/clients/ponder";
import { GENESIS_TIMESTAMP } from "../../constants/genesis-timestamp";

function getWeeksForRange(range: string): number {
  if (range === "90d") return 13;
  if (range === "7d") return 1;
  if (/^\d+w$/.test(range)) return Number(range.replace("w", ""));
  throw new Error(`Unsupported range: ${range}`);
}

export const polRouter = new Elysia({ prefix: "/pol" })
  .get(
    "/revenue/aggregate",
    async ({ query, set }) => {
      try {
        const range = query.range ?? "90d";
        const weeks = getWeeksForRange(range);
        const endWeek = getCompletedWeekNumber();
        const startWeek = Math.max(0, endWeek - (weeks - 1));

        const lifetime = await db
          .select({
            total: sql<string>`coalesce(sum(${polRevenueByRegionWeek.totalLq}), 0)`,
          })
          .from(polRevenueByRegionWeek)
          .where(lt(polRevenueByRegionWeek.weekNumber, endWeek + 1));

        const ninety = await db
          .select({
            total: sql<string>`coalesce(sum(${polRevenueByRegionWeek.totalLq}), 0)`,
          })
          .from(polRevenueByRegionWeek)
          .where(
            and(
              gte(polRevenueByRegionWeek.weekNumber, startWeek),
              lt(polRevenueByRegionWeek.weekNumber, endWeek + 1)
            )
          );

        const activeFarms = await db
          .select({
            count: sql<number>`count(distinct ${applications.farmId})`,
          })
          .from(applications)
          .where(sql`${applications.paymentAmount}::numeric > 0`);

        const yieldSnapshot =
          (await db.query.polYieldWeek.findFirst({
            where: (t, { eq }) => eq(t.weekNumber, endWeek),
          })) ?? null;

        const yieldData =
          yieldSnapshot ??
          (await fetchPonderPolYield({ range: "90d" }).then((r) => ({
            strategyReturns90dLq: r.strategyReturns90dLq,
            uniFees90dLq: r.uniFees90dLq,
            apy: r.apy,
          })));

        const ninetyDayYieldLq = (
          BigInt(String((yieldData as any).strategyReturns90dLq ?? "0")) +
          BigInt(String((yieldData as any).uniFees90dLq ?? "0"))
        ).toString();

        return {
          lifetime_lq: lifetime[0]?.total ?? "0",
          ninety_day_lq: ninety[0]?.total ?? "0",
          ninety_day_yield_lq: ninetyDayYieldLq,
          ninety_day_apy: String((yieldData as any).apy ?? "0"),
          active_farms: Number(activeFarms[0]?.count ?? 0),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal Server Error" };
      }
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
      }),
      detail: {
        summary: "PoL revenue aggregate (lifetime + range)",
        tags: [TAG.POL],
      },
    }
  )
  .get(
    "/revenue/farms",
    async ({ query, set }) => {
      try {
        const range = query.range ?? "90d";
        const weeks = getWeeksForRange(range);
        const endWeek = getCompletedWeekNumber();
        const startWeek = Math.max(0, endWeek - (weeks - 1));
        const prevStartWeek = Math.max(0, startWeek - weeks);
        const prevEndWeek = startWeek - 1;

        const activeFarms = await db
          .select({
            farmId: farms.id,
            name: farms.name,
            zoneId: farms.zoneId,
            auditCompleteDate: farms.auditCompleteDate,
            applicationId: applications.id,
            paymentAmount: applications.paymentAmount,
            ccPerWeek: applicationsAuditFieldsCRS.netCarbonCreditEarningWeekly,
            panels: applicationsAuditFieldsCRS.solarPanelsQuantity,
          })
          .from(farms)
          .innerJoin(applications, eq(applications.farmId, farms.id))
          .leftJoin(
            applicationsAuditFieldsCRS,
            eq(applicationsAuditFieldsCRS.applicationId, applications.id)
          )
          .where(sql`${applications.paymentAmount}::numeric > 0`);

        const farmIds = activeFarms.map((f) => f.farmId);
        if (farmIds.length === 0) return [];

        const docs = await db
          .select({
            applicationId: Documents.applicationId,
            url: Documents.url,
            createdAt: Documents.createdAt,
            name: Documents.name,
          })
          .from(Documents)
          .where(
            and(
              inArray(Documents.applicationId, activeFarms.map((f) => f.applicationId)),
              sql`${Documents.name} ilike '%after_install_pictures%'`
            )
          );

        const imageByApplication = new Map<string, { url: string; createdAtMs: number }>();
        for (const d of docs) {
          const curAt = d.createdAt ? new Date(d.createdAt).getTime() : 0;
          const prev = imageByApplication.get(d.applicationId);
          if (!prev || curAt > prev.createdAtMs) {
            imageByApplication.set(d.applicationId, { url: d.url, createdAtMs: curAt });
          }
        }

        const agg = await db
          .select({
            farmId: polRevenueByFarmWeek.farmId,
            lifetime: sql<string>`coalesce(sum(${polRevenueByFarmWeek.totalLq}), 0)`,
            ninety: sql<string>`coalesce(sum(case when ${polRevenueByFarmWeek.weekNumber} between ${startWeek} and ${endWeek} then ${polRevenueByFarmWeek.totalLq} else 0 end), 0)`,
            prev: sql<string>`coalesce(sum(case when ${polRevenueByFarmWeek.weekNumber} between ${prevStartWeek} and ${prevEndWeek} then ${polRevenueByFarmWeek.totalLq} else 0 end), 0)`,
          })
          .from(polRevenueByFarmWeek)
          .where(
            and(
              inArray(polRevenueByFarmWeek.farmId, farmIds),
              lt(polRevenueByFarmWeek.weekNumber, endWeek + 1)
            )
          )
          .groupBy(polRevenueByFarmWeek.farmId);

        const aggByFarm = new Map<string, { lifetime: string; ninety: string; prev: string }>();
        for (const r of agg) {
          aggByFarm.set(r.farmId, {
            lifetime: r.lifetime,
            ninety: r.ninety,
            prev: r.prev,
          });
        }

          return activeFarms.map((f) => {
          const ccPerWeek = String(f.ccPerWeek ?? "0");
          const cc = new Decimal(ccPerWeek);
          let auditWeek = endWeek;
          if (f.auditCompleteDate) {
            const auditTs = Math.floor(
              new Date(f.auditCompleteDate).getTime() / 1000
            );
            auditWeek =
              auditTs < GENESIS_TIMESTAMP ? 0 : getProtocolWeekForTimestamp(auditTs);
          }
          const creditWeeks = Math.max(0, endWeek - auditWeek + 1);
          const creditsTotal = cc.mul(creditWeeks).toString();

          const a = aggByFarm.get(f.farmId) ?? { lifetime: "0", ninety: "0", prev: "0" };
          const prev = new Decimal(a.prev);
          const deltaPct =
            prev.gt(0) ? new Decimal(a.ninety).minus(prev).div(prev).toNumber() : null;

          return {
            farm_id: f.farmId,
            name: f.name,
            zone_id: Number(f.zoneId),
            panels: Number(f.panels ?? 0),
            lifetime_lq: a.lifetime,
            ninety_day_lq: a.ninety,
            ninety_day_delta_pct: deltaPct,
            credits_total: creditsTotal,
            cc_per_week: ccPerWeek,
            image_url: imageByApplication.get(f.applicationId)?.url ?? null,
          };
        });
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal Server Error" };
      }
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
      }),
      detail: {
        summary: "PoL revenue by farm (lifetime + range)",
        tags: [TAG.POL],
      },
    }
  )
  .get(
    "/revenue/regions",
    async ({ query, set }) => {
      try {
        const range = query.range ?? "90d";
        const weeks = getWeeksForRange(range);
        const endWeek = getCompletedWeekNumber();
        const startWeek = Math.max(0, endWeek - (weeks - 1));

        const regionAgg = await db
          .select({
            region: polRevenueByRegionWeek.region,
            lifetime: sql<string>`coalesce(sum(${polRevenueByRegionWeek.totalLq}), 0)`,
            ninety: sql<string>`coalesce(sum(case when ${polRevenueByRegionWeek.weekNumber} between ${startWeek} and ${endWeek} then ${polRevenueByRegionWeek.totalLq} else 0 end), 0)`,
          })
          .from(polRevenueByRegionWeek)
          .where(lt(polRevenueByRegionWeek.weekNumber, endWeek + 1))
          .groupBy(polRevenueByRegionWeek.region);

        const activeFarms = await db
          .select({
            zoneId: farms.zoneId,
            farmId: farms.id,
            ccPerWeek: applicationsAuditFieldsCRS.netCarbonCreditEarningWeekly,
          })
          .from(farms)
          .innerJoin(applications, eq(applications.farmId, farms.id))
          .leftJoin(
            applicationsAuditFieldsCRS,
            eq(applicationsAuditFieldsCRS.applicationId, applications.id)
          )
          .where(sql`${applications.paymentAmount}::numeric > 0`);

        const ccByZoneId = new Map<number, Decimal>();
        const countByZoneId = new Map<number, number>();
        for (const f of activeFarms) {
          const zoneId = Number(f.zoneId);
          if (!Number.isFinite(zoneId)) continue;
          const cc = new Decimal(String(f.ccPerWeek ?? "0"));
          ccByZoneId.set(
            zoneId,
            (ccByZoneId.get(zoneId) ?? new Decimal(0)).add(cc)
          );
          countByZoneId.set(zoneId, (countByZoneId.get(zoneId) ?? 0) + 1);
        }

        const stakeRows = await db
          .select()
          .from(gctlStakedByRegionWeek)
          .where(eq(gctlStakedByRegionWeek.weekNumber, endWeek));
        const stakeByZoneId = new Map<number, string>();
        for (const s of stakeRows) {
          const zoneId = Number(s.region);
          if (!Number.isFinite(zoneId)) continue;
          stakeByZoneId.set(zoneId, String(s.gctlStakedRaw));
        }

        return regionAgg.flatMap((r) => {
          const zoneId = Number(r.region);
          if (!Number.isFinite(zoneId)) return [];
          const cc = ccByZoneId.get(zoneId) ?? new Decimal(0);
          return {
            zone_id: zoneId,
            lifetime_lq: r.lifetime,
            ninety_day_lq: r.ninety,
            cc_per_week: cc.toString(),
            farm_count: countByZoneId.get(zoneId) ?? 0,
            staked_gctl: stakeByZoneId.get(zoneId) ?? "0",
          };
        });
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal Server Error" };
      }
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
      }),
      detail: {
        summary: "PoL revenue by region (lifetime + range)",
        tags: [TAG.POL],
      },
    }
  );
