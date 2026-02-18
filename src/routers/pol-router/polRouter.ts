import { Elysia, t } from "elysia";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { TAG } from "../../constants";
import { db } from "../../db/db";
import {
  applications,
  applicationsAuditFieldsCRS,
  Documents,
  farms,
  gctlStakedByRegionWeek,
  polCashBounties,
  polRevenueByFarmWeek,
  polRevenueByRegionWeek,
  polYieldWeek,
} from "../../db/schema";
import { Decimal } from "../../pol/math/decimal";
import {
  getCompletedWeekNumber,
  getProtocolWeekEndTimestamp,
  getProtocolWeekForTimestamp,
  getProtocolWeekStartTimestamp,
} from "../../pol/protocolWeeks";
import {
  fetchPonderPolPoints,
  fetchPonderPolSummary,
  fetchPonderPolYield,
} from "../../pol/clients/ponder";
import { GENESIS_TIMESTAMP } from "../../constants/genesis-timestamp";
import {
  computeWeeklyPolLiquiditySeries,
  type PolLiquidityPoint,
} from "../../pol/liquidity/weeklyLiquiditySeries";
import { allocateAmountByWeights } from "../../pol/math/allocation";

function getWeeksForRange(range: string): number {
  if (range === "90d") return 13;
  if (range === "7d") return 1;
  if (/^\d+w$/.test(range)) return Number(range.replace("w", ""));
  throw new Error(`Unsupported range: ${range}`);
}

const CGP_ZONE_ID = 1;

function parseBigIntSafe(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function parseCrsCcPerWeekToScaledInt(ccPerWeek: unknown): bigint {
  // netCarbonCreditEarningWeekly is numeric(10,5) -> scale 5.
  if (ccPerWeek === null || ccPerWeek === undefined) return 0n;
  let dec: Decimal;
  try {
    dec = new Decimal(String(ccPerWeek));
  } catch {
    return 0n;
  }
  if (dec.isNegative()) return 0n;
  return BigInt(dec.mul(100000).toFixed(0, Decimal.ROUND_FLOOR));
}

function allocateDeltaNonNegative(params: {
  delta: bigint; // can be positive or negative
  baselineByKey: Map<string, bigint>; // baseline lifetime per farm (>= 0)
  weightsByKey: Map<string, bigint>;
}): Map<string, bigint> {
  const { delta, baselineByKey, weightsByKey } = params;
  const keys = Array.from(weightsByKey.keys()).sort();
  const out = new Map<string, bigint>();
  for (const k of keys) out.set(k, 0n);
  if (keys.length === 0 || delta === 0n) return out;

  // Positive deltas are always safe.
  if (delta > 0n) {
    const alloc = allocateAmountByWeights({ amount: delta, weightsByKey });
    for (const [k, amt] of alloc.entries()) out.set(String(k), amt);
    return out;
  }

  // Negative delta: subtract without taking any farm below 0 lifetime.
  // Water-fill style:
  // - Iterate: allocate proportional negative deltas.
  // - If any farm would go below 0, clamp it to -baseline and remove from pool.
  let remaining = delta; // negative
  const remainingKeys = new Set(keys);

  while (remaining < 0n && remainingKeys.size > 0) {
    const w = new Map<string, bigint>();
    for (const k of remainingKeys) w.set(k, weightsByKey.get(k) ?? 0n);
    const allocPos = allocateAmountByWeights({
      amount: -remaining,
      weightsByKey: w,
    });

    let clampedAny = false;
    for (const [k, amtPos] of allocPos.entries()) {
      const key = String(k);
      const curAdj = out.get(key) ?? 0n;
      const proposedAdj = curAdj - amtPos; // negative movement
      const baseline = baselineByKey.get(key) ?? 0n;
      if (baseline + proposedAdj < 0n) {
        out.set(key, -baseline);
        remaining -= (-baseline - curAdj); // consume portion of remaining delta
        remainingKeys.delete(key);
        clampedAny = true;
      }
    }

    if (clampedAny) continue;

    // No clamps: apply all and we're done.
    for (const [k, amtPos] of allocPos.entries()) {
      const key = String(k);
      out.set(key, (out.get(key) ?? 0n) - amtPos);
    }
    remaining = 0n;
  }

  // If we ran out of keys, we can't apply the full negative delta without going below zero.
  // Leave as-is; callers should tolerate imperfect matching in this pathological case.
  return out;
}

export const polRouter = new Elysia({ prefix: "/pol" })
  .get(
    "/liquidity",
    async ({ query, set }) => {
      try {
        const range = query.range ?? "12w";
        const weeks = getWeeksForRange(range);
        const endWeek = getCompletedWeekNumber();
        const startWeek = Math.max(0, endWeek - (weeks - 1));

        const from = getProtocolWeekStartTimestamp(startWeek);
        const to = getProtocolWeekEndTimestamp(endWeek);

        // Use bucketed points to keep the payload bounded while still letting us
        // deterministically pick "as-of week end" values. Protocol week boundaries
        // are always on hour boundaries, so hourly bucketing is sufficient.
        const pointsRes = await fetchPonderPolPoints({
          from,
          to,
          interval: "hour",
          includePrior: true,
          limit: 5000,
        });

        const points: PolLiquidityPoint[] = pointsRes.points
          .map((p) => ({
            timestamp: p.timestamp,
            spotPrice: p.spotPrice,
            endowment: { lq: p.endowment.lq },
            botActive: { lq: p.botActive.lq },
            total: { lq: p.total.lq },
          }))
          .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

        const series = computeWeeklyPolLiquiditySeries({
          startWeek,
          endWeek,
          points,
        });

        return {
          range,
          weekRange: { startWeek, endWeek },
          series,
          indexingComplete: pointsRes.indexingComplete,
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
        summary: "PoL liquidity weekly series (as-of protocol week end)",
        tags: [TAG.POL],
      },
    }
  )
  .get(
    "/revenue/aggregate",
    async ({ query, set }) => {
      try {
        const range = query.range ?? "90d";
        const weeks = getWeeksForRange(range);
        const endWeek = getCompletedWeekNumber();
        const startWeek = Math.max(0, endWeek - (weeks - 1));

        const [polSummary, revenueAggRows, activeFarms, yieldSnapshot] = await Promise.all([
          fetchPonderPolSummary().catch(() => null),
          db
            .select({
              lifetime: sql<string>`coalesce(sum(${polRevenueByRegionWeek.totalLq}), 0)`,
              ninety: sql<string>`coalesce(sum(case when ${polRevenueByRegionWeek.weekNumber} between ${startWeek} and ${endWeek} then ${polRevenueByRegionWeek.totalLq} else 0 end), 0)`,
            })
            .from(polRevenueByRegionWeek)
            .where(lt(polRevenueByRegionWeek.weekNumber, endWeek + 1)),
          db
            .select({
              count: sql<number>`count(distinct ${applications.farmId})`,
            })
            .from(applications)
            .where(sql`${applications.paymentAmount}::numeric > 0`),
          db.query.polYieldWeek.findFirst({
            where: (t, { eq }) => eq(t.weekNumber, endWeek),
          }),
        ]);

        const totalPolLqAtomic = polSummary ? parseBigIntSafe(polSummary.total.lq) : null;
        const revenueAgg = revenueAggRows[0] ?? { lifetime: "0", ninety: "0" };

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

        const lifetimeAttributedLqAtomic = parseBigIntSafe(revenueAgg.lifetime);
        const lifetimeDisplayLqAtomic =
          totalPolLqAtomic !== null ? totalPolLqAtomic : lifetimeAttributedLqAtomic;
        const lifetimeCgpAdjustmentLqAtomic =
          totalPolLqAtomic !== null ? totalPolLqAtomic - lifetimeAttributedLqAtomic : 0n;

        return {
          // "lifetime_lq" is a display value: by request, we make it sum to Total PoL by
          // allocating the delta into CGP (zone 1) farms/region in the other endpoints.
          lifetime_lq: lifetimeDisplayLqAtomic.toString(),
          lifetime_attributed_lq: lifetimeAttributedLqAtomic.toString(),
          lifetime_cgp_adjustment_lq: lifetimeCgpAdjustmentLqAtomic.toString(),
          ninety_day_lq: revenueAgg.ninety,
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
        description:
          "Returns attributed lifetime + range totals. lifetime_lq is aligned to current Total PoL (Ponder /pol/summary) via a CGP (zone 1) adjustment; debug fields expose the delta.",
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

        const [polSummary, activeFarms] = await Promise.all([
          fetchPonderPolSummary().catch(() => null),
          db
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
            .where(sql`${applications.paymentAmount}::numeric > 0`),
        ]);
        const totalPolLqAtomic = polSummary ? parseBigIntSafe(polSummary.total.lq) : null;

        const farmIds = activeFarms.map((f) => f.farmId);
        const applicationIds = activeFarms.map((f) => f.applicationId);
        if (farmIds.length === 0) return [];

        const [docs, agg] = await Promise.all([
          db
            .selectDistinctOn([Documents.applicationId], {
              applicationId: Documents.applicationId,
              url: Documents.url,
            })
            .from(Documents)
            .where(
              and(
                inArray(Documents.applicationId, applicationIds),
                sql`${Documents.name} ilike '%after_install_pictures%'`,
                eq(Documents.isShowingSolarPanels, true)
              )
            )
            .orderBy(Documents.applicationId, desc(Documents.createdAt), sql`ctid`),
          db
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
            .groupBy(polRevenueByFarmWeek.farmId),
        ]);

        const imageByApplication = new Map<string, string>();
        for (const d of docs) {
          imageByApplication.set(d.applicationId, d.url);
        }

        const aggByFarm = new Map<string, { lifetime: string; ninety: string; prev: string }>();
        for (const r of agg) {
          aggByFarm.set(r.farmId, {
            lifetime: r.lifetime,
            ninety: r.ninety,
            prev: r.prev,
          });
        }

        // Synthetic "CGP boost" to make sum(farm lifetime) == Total PoL.
        // The delta is applied to CGP farms (zone 1). If there are no CGP farms in the
        // active set, we fall back to distributing across all active farms so totals match.
        const baselineLifetimeByFarmId = new Map<string, bigint>();
        for (const f of activeFarms) {
          const a = aggByFarm.get(f.farmId) ?? { lifetime: "0", ninety: "0", prev: "0" };
          baselineLifetimeByFarmId.set(f.farmId, parseBigIntSafe(a.lifetime));
        }
        const baselineSum = Array.from(baselineLifetimeByFarmId.values()).reduce(
          (acc, v) => acc + v,
          0n
        );
        const boostTotal = totalPolLqAtomic !== null ? totalPolLqAtomic - baselineSum : 0n;

        const cgpFarmIds = activeFarms
          .filter((f) => Number(f.zoneId) === CGP_ZONE_ID)
          .map((f) => f.farmId);
        const eligibleFarmIds = cgpFarmIds.length > 0 ? cgpFarmIds : activeFarms.map((f) => f.farmId);

        const weightsByFarmId = new Map<string, bigint>();
        for (const f of activeFarms) {
          if (!eligibleFarmIds.includes(f.farmId)) continue;
          weightsByFarmId.set(f.farmId, parseCrsCcPerWeekToScaledInt(f.ccPerWeek));
        }
        const baselineEligible = new Map<string, bigint>();
        for (const id of eligibleFarmIds) {
          baselineEligible.set(id, baselineLifetimeByFarmId.get(id) ?? 0n);
        }
        const boostByFarmId =
          boostTotal !== 0n && eligibleFarmIds.length > 0
            ? allocateDeltaNonNegative({
                delta: boostTotal,
                baselineByKey: baselineEligible,
                weightsByKey: weightsByFarmId,
              })
            : new Map<string, bigint>();

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

          const baselineLifetime = parseBigIntSafe(a.lifetime);
          const boost = boostByFarmId.get(f.farmId) ?? 0n;
          const lifetimeWithBoost = (baselineLifetime + boost).toString();

          return {
            farm_id: f.farmId,
            name: f.name,
            zone_id: Number(f.zoneId),
            panels: Number(f.panels ?? 0),
            // Useful proxy for "built epoch" until we ingest Control's builtEpoch.
            audit_week: auditWeek,
            lifetime_lq: lifetimeWithBoost,
            lifetime_attributed_lq: baselineLifetime.toString(),
            lifetime_cgp_adjustment_lq: boost.toString(),
            ninety_day_lq: a.ninety,
            ninety_day_delta_pct: deltaPct,
            credits_total: creditsTotal,
            cc_per_week: ccPerWeek,
            image_url: imageByApplication.get(f.applicationId) ?? null,
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
        description:
          "Returns farm revenue aggregates. Includes audit_week (proxy for builtEpoch) and optional CGP lifetime adjustment so totals can match current Total PoL.",
        tags: [TAG.POL],
      },
    }
  )
  .get(
    "/bounties/farms",
    async ({ set }) => {
      try {
        const rows = await db
          .select({
            farmId: farms.id,
            name: farms.name,
            zoneId: farms.zoneId,
            bountyUsd: sql<string>`coalesce(sum(${polCashBounties.bountyUsd}), 0)`,
            applicationsCount: sql<number>`count(distinct ${applications.id})`,
            latestBountyUpdatedAt: sql<Date | null>`max(${polCashBounties.updatedAt})`,
          })
          .from(polCashBounties)
          .innerJoin(applications, eq(polCashBounties.applicationId, applications.id))
          .innerJoin(farms, eq(applications.farmId, farms.id))
          .groupBy(farms.id, farms.name, farms.zoneId)
          .orderBy(sql`sum(${polCashBounties.bountyUsd}) desc`, farms.name);

        return rows.map((r) => ({
          farm_id: r.farmId,
          name: r.name,
          zone_id: Number(r.zoneId),
          bounty_usd: r.bountyUsd,
          applications_count: Number(r.applicationsCount),
          latest_bounty_updated_at: r.latestBountyUpdatedAt,
        }));
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
      detail: {
        summary: "PoL cash bounties by farm",
        description:
          "Returns cash bounty totals (USD) per farm from pol_cash_bounties, grouped by farm.",
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

        const polSummary = await fetchPonderPolSummary().catch(() => null);
        const totalPolLqAtomic = polSummary ? parseBigIntSafe(polSummary.total.lq) : null;

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
          .select({ weekNumber: sql<number>`max(${gctlStakedByRegionWeek.weekNumber})` })
          .from(gctlStakedByRegionWeek)
          .where(lte(gctlStakedByRegionWeek.weekNumber, endWeek));

        const stakeWeek = stakeRows[0]?.weekNumber ?? null;
        const stakeSnapshotRows =
          stakeWeek == null
            ? []
            : await db
                .select()
                .from(gctlStakedByRegionWeek)
                .where(eq(gctlStakedByRegionWeek.weekNumber, stakeWeek));
        const stakeByZoneId = new Map<number, string>();
        for (const s of stakeSnapshotRows) {
          const zoneId = Number(s.region);
          if (!Number.isFinite(zoneId)) continue;
          stakeByZoneId.set(zoneId, String(s.gctlStakedRaw));
        }

        const baselineRegionLifetime = regionAgg.reduce(
          (acc, r) => acc + parseBigIntSafe(r.lifetime),
          0n
        );
        const deltaToMatch =
          totalPolLqAtomic !== null ? totalPolLqAtomic - baselineRegionLifetime : 0n;

        return regionAgg.flatMap((r) => {
          const zoneId = Number(r.region);
          if (!Number.isFinite(zoneId)) return [];
          const cc = ccByZoneId.get(zoneId) ?? new Decimal(0);

          const baselineLifetime = parseBigIntSafe(r.lifetime);
          const boost = zoneId === CGP_ZONE_ID ? deltaToMatch : 0n;
          const lifetimeWithBoost = (baselineLifetime + boost).toString();

          return {
            zone_id: zoneId,
            lifetime_lq: lifetimeWithBoost,
            lifetime_attributed_lq: baselineLifetime.toString(),
            lifetime_cgp_adjustment_lq: boost.toString(),
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
        description:
          "Returns region revenue aggregates. Region lifetime can include a CGP (zone 1) adjustment so the sum matches current Total PoL.",
        tags: [TAG.POL],
      },
    }
  );
