import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { createHash } from "crypto";
import { db } from "../../db/db";
import {
  applications,
  applicationsAuditFieldsCRS,
  fractionSplits,
  fractions,
  farms,
  fmiWeeklyInputs,
  gctlMintEvents,
  gctlStakedByRegionWeek,
  polCashBounties,
  polRevenueByFarmWeek,
  polRevenueByRegionWeek,
  polYieldWeek,
} from "../../db/schema";
import {
  getCompletedWeekNumber,
  getProtocolWeekEndTimestamp,
  getProtocolWeekForTimestamp,
  getProtocolWeekStartTimestamp,
} from "../../pol/protocolWeeks";
import { bucketEvenlyAcrossWeeks } from "../../pol/math/bucketing";
import { allocateAmountByWeights } from "../../pol/math/allocation";
import { Decimal } from "../../pol/math/decimal";
import { usdUsdc6ToLqAtomic, lqAtomicToUsdUsdc6 } from "../../pol/math/usdLq";
import { computeFmiMetrics } from "../../pol/fmi/computeFmiMetrics";
import { fetchWeeklyReportWeek } from "../../pol/clients/weekly-report";
import {
  fetchPonderFmiSellPressure,
  fetchPonderPolYield,
  fetchPonderSpotPriceByTimestamp,
} from "../../pol/clients/ponder";

const POL_DASHBOARD_START_WEEK = 97;

function parseNumericToBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
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

function parseUsdDollarsToUsdc6Atomic(dollars: unknown): bigint {
  // bountyUsd is numeric(20,2) in DB.
  if (dollars === null || dollars === undefined) return 0n;
  let dec: Decimal;
  try {
    dec = new Decimal(String(dollars));
  } catch {
    return 0n;
  }
  if (dec.isNegative()) return 0n;
  // dollars -> USDC6 atomic: * 1e6
  return BigInt(dec.mul(1_000_000).toFixed(0, Decimal.ROUND_FLOOR));
}

type ActiveFarmWeightRow = {
  farmId: string;
  zoneId: number;
  ccPerWeekScaled5: bigint;
};

async function loadActiveFarmWeights(): Promise<{
  farms: ActiveFarmWeightRow[];
  weightsByZoneId: Map<number, Map<string, bigint>>;
}> {
  const rows = await db
    .select({
      farmId: farms.id,
      zoneId: farms.zoneId,
      paymentAmount: applications.paymentAmount,
      ccPerWeek: applicationsAuditFieldsCRS.netCarbonCreditEarningWeekly,
    })
    .from(farms)
    .innerJoin(applications, eq(applications.farmId, farms.id))
    .leftJoin(
      applicationsAuditFieldsCRS,
      eq(applicationsAuditFieldsCRS.applicationId, applications.id)
    )
    .where(sql`${applications.paymentAmount}::numeric > 0`);

  const active: ActiveFarmWeightRow[] = [];
  const weightsByZoneId = new Map<number, Map<string, bigint>>();
  for (const r of rows) {
    const zoneId = Number(r.zoneId);
    if (!Number.isFinite(zoneId)) continue;
    const ccScaled = parseCrsCcPerWeekToScaledInt(r.ccPerWeek);
    const farmRow: ActiveFarmWeightRow = {
      farmId: r.farmId,
      zoneId,
      ccPerWeekScaled5: ccScaled,
    };
    active.push(farmRow);
    const map = weightsByZoneId.get(zoneId) ?? new Map<string, bigint>();
    map.set(r.farmId, ccScaled);
    weightsByZoneId.set(zoneId, map);
  }

  return { farms: active, weightsByZoneId };
}

type MinerSplitRow = {
  applicationId: string;
  zoneId: number;
  timestamp: number;
  amountRaw: string; // USDC6 atomic
};

async function loadMiningCenterSplits(params: {
  startTs: number;
  endTs: number;
}): Promise<MinerSplitRow[]> {
  const rows = await db
    .select({
      applicationId: fractions.applicationId,
      zoneId: farms.zoneId,
      timestamp: fractionSplits.timestamp,
      amountRaw: fractionSplits.amount,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .innerJoin(farms, eq(applications.farmId, farms.id))
    .where(
      and(
        eq(fractions.type, "mining-center"),
        gte(fractionSplits.timestamp, params.startTs),
        lt(fractionSplits.timestamp, params.endTs)
      )
    );

  return rows.map((r) => ({
    applicationId: r.applicationId,
    zoneId: Number(r.zoneId),
    timestamp: r.timestamp,
    amountRaw: String(r.amountRaw),
  }));
}

async function loadBountiesByApplicationId(): Promise<Map<string, bigint>> {
  const rows = await db.select().from(polCashBounties);
  const out = new Map<string, bigint>();
  for (const r of rows) {
    out.set(r.applicationId, parseUsdDollarsToUsdc6Atomic(r.bountyUsd));
  }
  return out;
}

async function computeRemainingBountyByApplicationId(params: {
  applicationIds: string[];
  bountiesByApplicationId: Map<string, bigint>;
  startTs: number;
}): Promise<Map<string, bigint>> {
  const appIdsWithBounty = params.applicationIds.filter((id) => {
    const b = params.bountiesByApplicationId.get(id) ?? 0n;
    return b > 0n;
  });
  const out = new Map<string, bigint>();
  if (appIdsWithBounty.length === 0) return out;

  const before = await db
    .select({
      applicationId: fractions.applicationId,
      totalBefore: sql<string>`coalesce(sum(${fractionSplits.amount}), 0)`,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(
      and(
        eq(fractions.type, "mining-center"),
        inArray(fractions.applicationId, appIdsWithBounty),
        lt(fractionSplits.timestamp, params.startTs)
      )
    )
    .groupBy(fractions.applicationId);

  const totalBeforeByApp = new Map<string, bigint>();
  for (const r of before) {
    totalBeforeByApp.set(r.applicationId, BigInt(r.totalBefore));
  }

  for (const appId of appIdsWithBounty) {
    const bounty = params.bountiesByApplicationId.get(appId) ?? 0n;
    const used = totalBeforeByApp.get(appId) ?? 0n;
    out.set(appId, used >= bounty ? 0n : bounty - used);
  }

  return out;
}

async function upsertPolYieldSnapshot(params: {
  weekNumber: number;
}): Promise<{ indexingComplete: boolean }> {
  const res = await fetchPonderPolYield({ range: "90d" });
  await db
    .insert(polYieldWeek)
    .values({
      weekNumber: params.weekNumber,
      strategyReturns90dLq: res.strategyReturns90dLq,
      uniFees90dLq: res.uniFees90dLq,
      polStartLq: res.polStartLq,
      apy: res.apy,
      yieldPerWeekLq: res.yieldPerWeekLq,
      indexingComplete: res.indexingComplete,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: polYieldWeek.weekNumber,
      set: {
        strategyReturns90dLq: res.strategyReturns90dLq,
        uniFees90dLq: res.uniFees90dLq,
        polStartLq: res.polStartLq,
        apy: res.apy,
        yieldPerWeekLq: res.yieldPerWeekLq,
        indexingComplete: res.indexingComplete,
        fetchedAt: new Date(),
      },
    });

  return { indexingComplete: res.indexingComplete };
}

async function ingestWeeklyReportForWeek(params: {
  weekNumber: number;
}): Promise<{ mintsUpserted: number; stakeUpserted: number }> {
  const report = await fetchWeeklyReportWeek({ weekNumber: params.weekNumber });

  // Stake snapshot (zoneStakeMap is a per-week snapshot).
  const zoneStakeMap = Array.isArray(report.zoneStakeMap)
    ? report.zoneStakeMap
    : [];
  if (zoneStakeMap.length > 0) {
    await db
      .insert(gctlStakedByRegionWeek)
      .values(
        zoneStakeMap.map(([zoneId, stake]) => ({
          weekNumber: params.weekNumber,
          region: String(zoneId),
          gctlStakedRaw: String(stake.totalStaked ?? "0"),
          fetchedAt: new Date(),
        }))
      )
      .onConflictDoUpdate({
        target: [
          gctlStakedByRegionWeek.weekNumber,
          gctlStakedByRegionWeek.region,
        ],
        set: {
          gctlStakedRaw: sql`excluded.gctl_staked_raw`,
          fetchedAt: new Date(),
        },
      });
  }

  function normalizeMintEventId(txId: unknown, logIndex: unknown): string {
    const rawTxId = String(txId ?? "");
    const li = Number(logIndex ?? 0);
    // Keep the raw tx hash when logIndex is 0 so we don't duplicate rows that were previously ingested.
    if (/^0x[0-9a-fA-F]{64}$/.test(rawTxId) && li === 0) return rawTxId;
    // For any non-hash txId (premints, etc) or non-zero logIndex, hash deterministically into 0x + 64 hex chars.
    // This guarantees uniqueness per (txId, logIndex) without needing a schema change.
    const digest = createHash("sha256")
      .update(`${rawTxId}:${Number.isFinite(li) ? li : 0}`)
      .digest("hex");
    return `0x${digest}`;
  }

  // Mint events (append-only, keyed by txId).
  const minted = Array.isArray(report.controlMintedEvents)
    ? report.controlMintedEvents
    : [];
  if (minted.length > 0) {
    await db
      .insert(gctlMintEvents)
      .values(
        minted.map((ev) => ({
          txId: normalizeMintEventId(ev.txId, ev.logIndex),
          wallet: String(ev.wallet),
          epoch: Number(ev.epoch),
          currency: String(ev.currency),
          amountRaw: String(ev.amountRaw),
          gctlMintedRaw: String(ev.gctlMinted),
          ts: new Date(String(ev.ts)),
          createdAt: new Date(),
        }))
      )
      .onConflictDoUpdate({
        target: gctlMintEvents.txId,
        set: {
          wallet: sql`excluded.wallet`,
          epoch: sql`excluded.epoch`,
          currency: sql`excluded.currency`,
          amountRaw: sql`excluded.amount_raw`,
          gctlMintedRaw: sql`excluded.gctl_minted_raw`,
          ts: sql`excluded.ts`,
        },
      });
  }

  return { mintsUpserted: minted.length, stakeUpserted: zoneStakeMap.length };
}

async function ingestWeeklyReports(params: {
  startWeek: number;
  endWeek: number;
}): Promise<{ mintsUpserted: number; stakeUpserted: number }> {
  const limit = pLimit(5);
  let mintsUpserted = 0;
  let stakeUpserted = 0;

  const tasks: Array<Promise<void>> = [];
  for (let w = params.startWeek; w <= params.endWeek; w++) {
    tasks.push(
      limit(async () => {
        try {
          const res = await ingestWeeklyReportForWeek({ weekNumber: w });
          mintsUpserted += res.mintsUpserted;
          stakeUpserted += res.stakeUpserted;
        } catch (e) {
          console.warn("[PoL Dashboard] weekly report ingest failed", {
            week: w,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })
    );
  }
  await Promise.all(tasks);
  return { mintsUpserted, stakeUpserted };
}

async function recomputeRevenueSnapshots(params: {
  startWeek: number;
  endWeek: number;
}): Promise<{ regionRows: number; farmRows: number }> {
  // Weekly report history starts at week 97; we intentionally do not attribute earlier weeks.
  const startWeek = Math.max(POL_DASHBOARD_START_WEEK, params.startWeek);
  const endWeek = Math.max(startWeek, params.endWeek);

  const earliestWeekNeeded = Math.max(POL_DASHBOARD_START_WEEK, startWeek - 9);
  const startTs = getProtocolWeekStartTimestamp(earliestWeekNeeded);
  const endTs = getProtocolWeekEndTimestamp(endWeek);

  const [{ farms: activeFarms, weightsByZoneId }, bounties, splits, stakeRows, mints, yieldRows] =
    await Promise.all([
      loadActiveFarmWeights(),
      loadBountiesByApplicationId(),
      loadMiningCenterSplits({ startTs, endTs }),
      db
        .select()
        .from(gctlStakedByRegionWeek)
        .where(
          and(
            gte(gctlStakedByRegionWeek.weekNumber, startWeek),
            lt(gctlStakedByRegionWeek.weekNumber, endWeek + 1)
          )
        ),
      db
        .select()
        .from(gctlMintEvents)
        .where(
          and(
            gte(gctlMintEvents.epoch, earliestWeekNeeded),
            lt(gctlMintEvents.epoch, endWeek + 1)
          )
        ),
      db
        .select()
        .from(polYieldWeek)
        .where(
          and(
            gte(polYieldWeek.weekNumber, earliestWeekNeeded),
            lt(polYieldWeek.weekNumber, endWeek + 1)
          )
        ),
    ]);

  // stakeByWeek[week] => weightsByZoneId(zoneId => totalStakedRaw)
  const stakeByWeek = new Map<number, Map<number, bigint>>();
  for (const s of stakeRows) {
    const w = s.weekNumber;
    const zoneId = Number(s.region);
    if (!Number.isFinite(zoneId)) continue;
    const map = stakeByWeek.get(w) ?? new Map<number, bigint>();
    map.set(zoneId, parseNumericToBigInt(s.gctlStakedRaw));
    stakeByWeek.set(w, map);
  }

  const splitsByApplication = new Map<string, MinerSplitRow[]>();
  for (const s of splits) {
    const arr = splitsByApplication.get(s.applicationId) ?? [];
    arr.push(s);
    splitsByApplication.set(s.applicationId, arr);
  }
  for (const [, arr] of splitsByApplication) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  const remainingBountyByApp = await computeRemainingBountyByApplicationId({
    applicationIds: Array.from(splitsByApplication.keys()),
    bountiesByApplicationId: bounties,
    startTs,
  });

  const limit = pLimit(5);
  const spotPriceCache = new Map<number, string>();
  async function getSpotPriceAtTimestamp(ts: number): Promise<string> {
    const cached = spotPriceCache.get(ts);
    if (cached) return cached;
    const res = await fetchPonderSpotPriceByTimestamp({ timestamp: ts });
    spotPriceCache.set(ts, res.spotPrice);
    return res.spotPrice;
  }

  // Accumulators
  const zoneWeekMiner = new Map<number, Map<number, bigint>>();
  const zoneWeekMints = new Map<number, Map<number, bigint>>();
  const zoneWeekYield = new Map<number, Map<number, bigint>>();
  const farmWeekMiner = new Map<string, Map<number, bigint>>();
  const farmWeekMints = new Map<string, Map<number, bigint>>();
  const farmWeekYield = new Map<string, Map<number, bigint>>();

  function addToNested<K>(
    outer: Map<K, Map<number, bigint>>,
    key: K,
    week: number,
    amount: bigint
  ) {
    const inner = outer.get(key) ?? new Map<number, bigint>();
    inner.set(week, (inner.get(week) ?? 0n) + amount);
    outer.set(key, inner);
  }

  // 1) Miner sales -> region (100%) -> farms by CC weights.
  const minerTasks: Promise<void>[] = [];
  for (const [applicationId, appSplits] of splitsByApplication) {
    let remainingBounty = remainingBountyByApp.get(applicationId) ?? 0n;
    for (const split of appSplits) {
      const amountUsd = parseNumericToBigInt(split.amountRaw);
      const netUsd = amountUsd > remainingBounty ? amountUsd - remainingBounty : 0n;
      remainingBounty = amountUsd > remainingBounty ? 0n : remainingBounty - amountUsd;
      if (netUsd === 0n) continue;

      const saleWeek = getProtocolWeekForTimestamp(split.timestamp);
      const zoneId = split.zoneId;
      minerTasks.push(
        limit(async () => {
          const spot = await getSpotPriceAtTimestamp(split.timestamp);
          const lqTotal = usdUsdc6ToLqAtomic({
            usdUsdc6: netUsd,
            spotPriceUsdgPerGlw: spot,
          });
          const buckets = bucketEvenlyAcrossWeeks({
            amount: lqTotal,
            startWeek: saleWeek,
            weeks: 10,
          });

          for (const b of buckets) {
            if (b.week < startWeek || b.week > endWeek) continue;
            addToNested(zoneWeekMiner, zoneId, b.week, b.amount);

            const farmWeights = weightsByZoneId.get(zoneId);
            if (!farmWeights || farmWeights.size === 0) continue;
            const allocations = allocateAmountByWeights({
              amount: b.amount,
              weightsByKey: farmWeights,
            });
            for (const [farmId, farmAmt] of allocations.entries()) {
              addToNested(farmWeekMiner, farmId, b.week, farmAmt);
            }
          }
        })
      );
    }
  }
  await Promise.all(minerTasks);

  // 2) GCTL mints -> regions by staked share (per bucket week) -> farms by CC weights.
  const mintTasks: Promise<void>[] = [];
  for (const mint of mints) {
    const mintWeek = mint.epoch;
    const amountUsd = parseNumericToBigInt(mint.amountRaw);
    if (amountUsd === 0n) continue;
    const tsUnix = Math.floor(new Date(mint.ts).getTime() / 1000);

    mintTasks.push(
      limit(async () => {
        const spot = await getSpotPriceAtTimestamp(tsUnix);
        const mintLq = usdUsdc6ToLqAtomic({
          usdUsdc6: amountUsd,
          spotPriceUsdgPerGlw: spot,
        });

        const buckets = bucketEvenlyAcrossWeeks({
          amount: mintLq,
          startWeek: mintWeek,
          weeks: 10,
        });

        for (const b of buckets) {
          if (b.week < startWeek || b.week > endWeek) continue;

          const stakeWeights = stakeByWeek.get(b.week);
          if (!stakeWeights || stakeWeights.size === 0) continue;

          const regionAlloc = allocateAmountByWeights({
            amount: b.amount,
            weightsByKey: stakeWeights,
          });
          for (const [zoneId, zoneAmt] of regionAlloc.entries()) {
            addToNested(zoneWeekMints, zoneId, b.week, zoneAmt);

            const farmWeights = weightsByZoneId.get(zoneId);
            if (!farmWeights || farmWeights.size === 0) continue;
            const farmAlloc = allocateAmountByWeights({
              amount: zoneAmt,
              weightsByKey: farmWeights,
            });
            for (const [farmId, farmAmt] of farmAlloc.entries()) {
              addToNested(farmWeekMints, farmId, b.week, farmAmt);
            }
          }
        }
      })
    );
  }
  await Promise.all(mintTasks);

  // 3) GCTL yield attribution (PoL yield) -> regions by staked share -> farms by CC weights.
  const yieldByWeek = new Map<number, bigint>();
  for (const y of yieldRows) {
    yieldByWeek.set(y.weekNumber, parseNumericToBigInt(y.yieldPerWeekLq));
  }
  const fallbackYield = yieldByWeek.get(endWeek) ?? 0n;

  for (let sourceWeek = earliestWeekNeeded; sourceWeek <= endWeek; sourceWeek++) {
    const yieldLq = yieldByWeek.get(sourceWeek) ?? fallbackYield;
    if (yieldLq === 0n) continue;

    const buckets = bucketEvenlyAcrossWeeks({
      amount: yieldLq,
      startWeek: sourceWeek,
      weeks: 10,
    });

    for (const b of buckets) {
      if (b.week < startWeek || b.week > endWeek) continue;
      const stakeWeights = stakeByWeek.get(b.week);
      if (!stakeWeights || stakeWeights.size === 0) continue;

      const regionAlloc = allocateAmountByWeights({
        amount: b.amount,
        weightsByKey: stakeWeights,
      });
      for (const [zoneId, zoneAmt] of regionAlloc.entries()) {
        addToNested(zoneWeekYield, zoneId, b.week, zoneAmt);

        const farmWeights = weightsByZoneId.get(zoneId);
        if (!farmWeights || farmWeights.size === 0) continue;
        const farmAlloc = allocateAmountByWeights({
          amount: zoneAmt,
          weightsByKey: farmWeights,
        });
        for (const [farmId, farmAmt] of farmAlloc.entries()) {
          addToNested(farmWeekYield, farmId, b.week, farmAmt);
        }
      }
    }
  }

  // Upsert snapshots (delete and re-insert in range for determinism).
  const { regionRows, farmRows } = await db.transaction(async (tx) => {
    await tx
      .delete(polRevenueByRegionWeek)
      .where(
        and(
          gte(polRevenueByRegionWeek.weekNumber, startWeek),
          lt(polRevenueByRegionWeek.weekNumber, endWeek + 1)
        )
      );
    await tx
      .delete(polRevenueByFarmWeek)
      .where(
        and(
          gte(polRevenueByFarmWeek.weekNumber, startWeek),
          lt(polRevenueByFarmWeek.weekNumber, endWeek + 1)
        )
      );

    let regionRows = 0;
    for (const [zoneId, byWeekMiner] of zoneWeekMiner.entries()) {
      const byWeekMints =
        zoneWeekMints.get(zoneId) ?? new Map<number, bigint>();
      const byWeekYield =
        zoneWeekYield.get(zoneId) ?? new Map<number, bigint>();
      for (let w = startWeek; w <= endWeek; w++) {
        const miner = byWeekMiner.get(w) ?? 0n;
        const mints = byWeekMints.get(w) ?? 0n;
        const yieldLq = byWeekYield.get(w) ?? 0n;
        const total = miner + mints + yieldLq;
        if (total === 0n) continue;
        await tx.insert(polRevenueByRegionWeek).values({
          weekNumber: w,
          region: String(zoneId),
          totalLq: total.toString(),
          minerSalesLq: miner.toString(),
          gctlMintsLq: mints.toString(),
          polYieldLq: yieldLq.toString(),
          computedAt: new Date(),
        });
        regionRows++;
      }
    }

    // Regions that only have mints.
    for (const [zoneId, byWeekMints] of zoneWeekMints.entries()) {
      if (zoneWeekMiner.has(zoneId)) continue;
      if (zoneWeekYield.has(zoneId)) continue;
      for (let w = startWeek; w <= endWeek; w++) {
        const mints = byWeekMints.get(w) ?? 0n;
        if (mints === 0n) continue;
        await tx.insert(polRevenueByRegionWeek).values({
          weekNumber: w,
          region: String(zoneId),
          totalLq: mints.toString(),
          minerSalesLq: "0",
          gctlMintsLq: mints.toString(),
          polYieldLq: "0",
          computedAt: new Date(),
        });
        regionRows++;
      }
    }

    // Regions that only have yield.
    for (const [zoneId, byWeekYield] of zoneWeekYield.entries()) {
      if (zoneWeekMiner.has(zoneId) || zoneWeekMints.has(zoneId)) continue;
      for (let w = startWeek; w <= endWeek; w++) {
        const yieldLq = byWeekYield.get(w) ?? 0n;
        if (yieldLq === 0n) continue;
        await tx.insert(polRevenueByRegionWeek).values({
          weekNumber: w,
          region: String(zoneId),
          totalLq: yieldLq.toString(),
          minerSalesLq: "0",
          gctlMintsLq: "0",
          polYieldLq: yieldLq.toString(),
          computedAt: new Date(),
        });
        regionRows++;
      }
    }

    let farmRows = 0;
    const farmIds = new Set<string>([
      ...farmWeekMiner.keys(),
      ...farmWeekMints.keys(),
      ...farmWeekYield.keys(),
    ]);
    for (const farmId of Array.from(farmIds)) {
      const byWeekMiner = farmWeekMiner.get(farmId) ?? new Map<number, bigint>();
      const byWeekMints = farmWeekMints.get(farmId) ?? new Map<number, bigint>();
      const byWeekYield = farmWeekYield.get(farmId) ?? new Map<number, bigint>();
      for (let w = startWeek; w <= endWeek; w++) {
        const miner = byWeekMiner.get(w) ?? 0n;
        const mints = byWeekMints.get(w) ?? 0n;
        const yieldLq = byWeekYield.get(w) ?? 0n;
        const total = miner + mints + yieldLq;
        if (total === 0n) continue;
        await tx.insert(polRevenueByFarmWeek).values({
          weekNumber: w,
          farmId,
          totalLq: total.toString(),
          minerSalesLq: miner.toString(),
          gctlMintsLq: mints.toString(),
          polYieldLq: yieldLq.toString(),
          computedAt: new Date(),
        });
        farmRows++;
      }
    }

    return { regionRows, farmRows };
  });

  // silence unused (kept around for planned extensions like “farm registry”)
  void activeFarms;

  return { regionRows, farmRows };
}

function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) return 0n;
  return (a * b) / denom;
}

async function recomputeFmiWeeklyInputs(params: {
  startWeek: number;
  endWeek: number;
}): Promise<{ upserted: number }> {
  const startWeek = Math.max(POL_DASHBOARD_START_WEEK, params.startWeek);
  const endWeek = Math.max(startWeek, params.endWeek);
  const earliestWeekNeeded = Math.max(POL_DASHBOARD_START_WEEK, startWeek);
  const startTs = getProtocolWeekStartTimestamp(earliestWeekNeeded);
  const endTs = getProtocolWeekEndTimestamp(endWeek);

  const [bounties, splits, mintRows, polYieldRows] = await Promise.all([
    loadBountiesByApplicationId(),
    loadMiningCenterSplits({ startTs, endTs }),
    db
      .select()
      .from(gctlMintEvents)
      .where(
        and(gte(gctlMintEvents.epoch, startWeek), lt(gctlMintEvents.epoch, endWeek + 1))
      ),
    db
      .select()
      .from(polYieldWeek)
      .where(
        and(
          gte(polYieldWeek.weekNumber, startWeek),
          lt(polYieldWeek.weekNumber, endWeek + 1)
        )
      ),
  ]);

  // Miner sales weekly USD after bounty (deduct applied earliest-first per application).
  const minerUsdByWeek = new Map<number, bigint>();
  const splitsByApplication = new Map<string, MinerSplitRow[]>();
  for (const s of splits) {
    const arr = splitsByApplication.get(s.applicationId) ?? [];
    arr.push(s);
    splitsByApplication.set(s.applicationId, arr);
  }
  for (const [, arr] of splitsByApplication) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  const remainingBountyByApp = await computeRemainingBountyByApplicationId({
    applicationIds: Array.from(splitsByApplication.keys()),
    bountiesByApplicationId: bounties,
    startTs,
  });
  for (const [applicationId, appSplits] of splitsByApplication) {
    let remainingBounty = remainingBountyByApp.get(applicationId) ?? 0n;
    for (const split of appSplits) {
      const amountUsd = parseNumericToBigInt(split.amountRaw);
      const netUsd = amountUsd > remainingBounty ? amountUsd - remainingBounty : 0n;
      remainingBounty = amountUsd > remainingBounty ? 0n : remainingBounty - amountUsd;
      if (netUsd === 0n) continue;
      const week = getProtocolWeekForTimestamp(split.timestamp);
      minerUsdByWeek.set(week, (minerUsdByWeek.get(week) ?? 0n) + netUsd);
    }
  }

  const gctlMintUsdByWeek = new Map<number, bigint>();
  for (const mint of mintRows) {
    const week = mint.epoch;
    const usd = parseNumericToBigInt(mint.amountRaw);
    gctlMintUsdByWeek.set(week, (gctlMintUsdByWeek.get(week) ?? 0n) + usd);
  }

  // PoL yield weekly USD: use yieldPerWeekLq from latest snapshot, convert using spot price at week end.
  const yieldLqByWeek = new Map<number, bigint>();
  for (const r of polYieldRows) {
    yieldLqByWeek.set(r.weekNumber, parseNumericToBigInt(r.yieldPerWeekLq));
  }
  const fallbackYieldPerWeekLqAtomic = yieldLqByWeek.get(endWeek) ?? 0n;

  const sellPressure = await fetchPonderFmiSellPressure({ range: "12w" });
  const sellByWeekGlw = new Map<number, bigint>();
  for (const pt of sellPressure.series ?? []) {
    sellByWeekGlw.set(pt.week, BigInt(pt.sell.glw));
  }

  const limit = pLimit(5);
  const spotPriceCache = new Map<number, string>();
  async function getSpotPriceAtWeekEnd(week: number): Promise<string> {
    const endTs = getProtocolWeekEndTimestamp(week);
    const cached = spotPriceCache.get(endTs);
    if (cached) return cached;
    const res = await fetchPonderSpotPriceByTimestamp({ timestamp: endTs });
    spotPriceCache.set(endTs, res.spotPrice);
    return res.spotPrice;
  }

  const upserts: Array<Promise<void>> = [];
  for (let week = startWeek; week <= endWeek; week++) {
    upserts.push(
      limit(async () => {
        const spot = await getSpotPriceAtWeekEnd(week);
        const minerUsd = minerUsdByWeek.get(week) ?? 0n;
        const gctlUsd = gctlMintUsdByWeek.get(week) ?? 0n;
        const yieldLqAtomic =
          yieldLqByWeek.get(week) ?? fallbackYieldPerWeekLqAtomic;
        const polYieldUsd = yieldLqAtomic
          ? lqAtomicToUsdUsdc6({
              lqAtomic: yieldLqAtomic,
              spotPriceUsdgPerGlw: spot,
            })
          : 0n;

        const sellGlw = sellByWeekGlw.get(week) ?? 0n;
        // dexSellUsd = glw * price (USDC6) / 1e18
        const priceUsdc6Atomic = BigInt(
          new Decimal(spot).mul(1_000_000).toFixed(0, Decimal.ROUND_FLOOR)
        );
        const dexSellUsd =
          sellGlw === 0n
            ? 0n
            : mulDiv(
                sellGlw,
                priceUsdc6Atomic,
                1_000_000_000_000_000_000n
              );

        const buy = minerUsd + gctlUsd + polYieldUsd;
        const sell = dexSellUsd;
        const { netUsdUsdc6: net, buySellRatio: ratio } = computeFmiMetrics({
          minerSalesUsdUsdc6: minerUsd,
          gctlMintsUsdUsdc6: gctlUsd,
          polYieldUsdUsdc6: polYieldUsd,
          dexSellPressureUsdUsdc6: sell,
        });

        await db
          .insert(fmiWeeklyInputs)
          .values({
            weekNumber: week,
            minerSalesUsd: minerUsd.toString(),
            gctlMintsUsd: gctlUsd.toString(),
            polYieldUsd: polYieldUsd.toString(),
            dexSellPressureUsd: sell.toString(),
            buyPressureUsd: buy.toString(),
            sellPressureUsd: sell.toString(),
            netUsd: net.toString(),
            buySellRatio: ratio,
            indexingComplete: sellPressure.indexingComplete ?? false,
            computedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: fmiWeeklyInputs.weekNumber,
            set: {
              minerSalesUsd: minerUsd.toString(),
              gctlMintsUsd: gctlUsd.toString(),
              polYieldUsd: polYieldUsd.toString(),
              dexSellPressureUsd: sell.toString(),
              buyPressureUsd: buy.toString(),
              sellPressureUsd: sell.toString(),
              netUsd: net.toString(),
              buySellRatio: ratio,
              indexingComplete: sellPressure.indexingComplete ?? false,
              computedAt: new Date(),
            },
          });
      })
    );
  }
  await Promise.all(upserts);
  return { upserted: upserts.length };
}

export async function updatePolDashboard(params?: {
  // When provided, forces recompute from that week up to the latest completed week.
  backfillFromWeek?: number;
}): Promise<{
  completedWeek: number;
  polYieldIndexedComplete: boolean;
  gctlMintsUpserted: number;
  gctlStakeUpserted: number;
  revenueRange: { startWeek: number; endWeek: number };
  fmiRange: { startWeek: number; endWeek: number };
}> {
  const completedWeek = getCompletedWeekNumber();
  const polYield = await upsertPolYieldSnapshot({ weekNumber: completedWeek });

  // Default to recomputing a window big enough to cover 10-week buckets and 13-week rollups.
  const hasExistingRevenue =
    (await db
      .select({ c: sql<number>`count(*)` })
      .from(polRevenueByRegionWeek)
      .limit(1)
      .then((r) => Number(r[0]?.c ?? 0))) > 0;

  const startWeekRaw =
    params?.backfillFromWeek ??
    (hasExistingRevenue
      ? Math.max(0, completedWeek - 40)
      : POL_DASHBOARD_START_WEEK);
  const startWeek = Math.max(POL_DASHBOARD_START_WEEK, startWeekRaw);
  const endWeek = completedWeek;

  // Ingest enough history to cover 10-week bucketing that backfills into the requested range.
  const ingestStartWeek = Math.max(POL_DASHBOARD_START_WEEK, startWeek - 9);
  const ingest = await ingestWeeklyReports({
    startWeek: ingestStartWeek,
    endWeek,
  });

  await recomputeRevenueSnapshots({ startWeek, endWeek });

  const fmiStart = Math.max(POL_DASHBOARD_START_WEEK, completedWeek - 20);
  await recomputeFmiWeeklyInputs({ startWeek: fmiStart, endWeek });

  return {
    completedWeek,
    polYieldIndexedComplete: polYield.indexingComplete,
    gctlMintsUpserted: ingest.mintsUpserted,
    gctlStakeUpserted: ingest.stakeUpserted,
    revenueRange: { startWeek, endWeek },
    fmiRange: { startWeek: fmiStart, endWeek },
  };
}
