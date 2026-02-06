import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import pLimit from "p-limit";
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
import {
  fetchControlMintedEvents,
  fetchControlRegionsActiveSummary,
} from "../../pol/clients/control";
import {
  fetchPonderFmiSellPressure,
  fetchPonderPolYield,
  fetchPonderSpotPriceByTimestamp,
} from "../../pol/clients/ponder";

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
  region: string;
  ccPerWeekScaled5: bigint;
};

function summarizeSetDiff(params: {
  leftName: string;
  rightName: string;
  left: Set<string>;
  right: Set<string>;
  sampleSize?: number;
}): { missingFromRight: string[]; missingFromLeft: string[] } {
  const sampleSize = params.sampleSize ?? 10;
  const missingFromRight: string[] = [];
  const missingFromLeft: string[] = [];

  for (const v of Array.from(params.left).sort()) {
    if (!params.right.has(v)) {
      missingFromRight.push(v);
      if (missingFromRight.length >= sampleSize) break;
    }
  }
  for (const v of Array.from(params.right).sort()) {
    if (!params.left.has(v)) {
      missingFromLeft.push(v);
      if (missingFromLeft.length >= sampleSize) break;
    }
  }

  return { missingFromRight, missingFromLeft };
}

function logRegionAlignmentDiagnostics(params: {
  startWeek: number;
  endWeek: number;
  regionsWithActiveFarms: Set<string>;
  stakeByWeek: Map<number, Map<string, bigint>>;
}) {
  const regionsWithStake = new Set<string>();
  for (const [, byRegion] of params.stakeByWeek.entries()) {
    for (const r of byRegion.keys()) regionsWithStake.add(r);
  }

  const diff = summarizeSetDiff({
    leftName: "farms.region",
    rightName: "control.region.code",
    left: params.regionsWithActiveFarms,
    right: regionsWithStake,
  });

  const weeksMissingStake: number[] = [];
  for (let w = params.startWeek; w <= params.endWeek; w++) {
    const weights = params.stakeByWeek.get(w);
    if (!weights || weights.size === 0) {
      weeksMissingStake.push(w);
      continue;
    }
    let sum = 0n;
    for (const v of weights.values()) sum += v;
    if (sum === 0n) weeksMissingStake.push(w);
  }

  if (
    diff.missingFromRight.length > 0 ||
    diff.missingFromLeft.length > 0 ||
    weeksMissingStake.length > 0
  ) {
    console.warn("[PoL Dashboard] Region alignment diagnostics", {
      weekRange: { startWeek: params.startWeek, endWeek: params.endWeek },
      note: "If control.region.code != farms.region, GCTL mint attribution by region may be wrong or skipped.",
      farmsRegionsMissingInControlStake: diff.missingFromLeft,
      controlStakeRegionsMissingInFarms: diff.missingFromRight,
      weeksMissingStakeDataSample: weeksMissingStake.slice(0, 10),
      weeksMissingStakeDataCount: weeksMissingStake.length,
    });
  }
}

async function loadActiveFarmWeights(): Promise<{
  farms: ActiveFarmWeightRow[];
  weightsByRegion: Map<string, Map<string, bigint>>;
}> {
  const rows = await db
    .select({
      farmId: farms.id,
      region: farms.region,
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
  const weightsByRegion = new Map<string, Map<string, bigint>>();
  for (const r of rows) {
    const region = r.region ?? "__UNSET__";
    if (region === "__UNSET__") continue;
    const ccScaled = parseCrsCcPerWeekToScaledInt(r.ccPerWeek);
    const farmRow: ActiveFarmWeightRow = {
      farmId: r.farmId,
      region,
      ccPerWeekScaled5: ccScaled,
    };
    active.push(farmRow);
    const map = weightsByRegion.get(region) ?? new Map<string, bigint>();
    map.set(r.farmId, ccScaled);
    weightsByRegion.set(region, map);
  }

  return { farms: active, weightsByRegion };
}

type MinerSplitRow = {
  applicationId: string;
  region: string;
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
      region: farms.region,
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
    region: r.region,
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

async function ingestControlMintEvents(): Promise<{ upserted: number }> {
  const latest = await db
    .select({ maxTs: sql<string>`max(${gctlMintEvents.ts})` })
    .from(gctlMintEvents);
  const latestTs = latest[0]?.maxTs ? new Date(latest[0].maxTs) : null;

  const LIMIT = 200;
  let page = 1;
  let upserted = 0;
  while (true) {
    const res = await fetchControlMintedEvents({ page, limit: LIMIT });
    if (!res.events || res.events.length === 0) break;

    let shouldStop = false;
    for (const ev of res.events) {
      const ts = new Date(ev.ts);
      if (latestTs && ts <= latestTs) {
        shouldStop = true;
        continue;
      }
      await db
        .insert(gctlMintEvents)
        .values({
          txId: ev.txId,
          wallet: ev.wallet,
          epoch: ev.epoch,
          currency: ev.currency,
          amountRaw: ev.amountRaw,
          gctlMintedRaw: ev.gctlMinted,
          ts,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      upserted++;
    }

    if (shouldStop) break;
    page++;
    if (page > 2000) break; // safety valve
  }

  return { upserted };
}

async function ingestControlGctlStakeByRegion(params: {
  epochs: number;
}): Promise<{ upserted: number }> {
  const res = await fetchControlRegionsActiveSummary({ epochs: params.epochs });
  let upserted = 0;

  // Persist region code (must match farms.region for attribution).
  for (const region of res.regions ?? []) {
    for (const row of region.data ?? []) {
      await db
        .insert(gctlStakedByRegionWeek)
        .values({
          weekNumber: row.epoch,
          region: region.code,
          gctlStakedRaw: row.gctlStaked,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [gctlStakedByRegionWeek.weekNumber, gctlStakedByRegionWeek.region],
          set: {
            gctlStakedRaw: row.gctlStaked,
            fetchedAt: new Date(),
          },
        });
      upserted++;
    }
  }
  return { upserted };
}

async function recomputeRevenueSnapshots(params: {
  startWeek: number;
  endWeek: number;
}): Promise<{ regionRows: number; farmRows: number }> {
  const earliestWeekNeeded = Math.max(0, params.startWeek - 9);
  const startTs = getProtocolWeekStartTimestamp(earliestWeekNeeded);
  const endTs = getProtocolWeekEndTimestamp(params.endWeek);

  const [{ farms: activeFarms, weightsByRegion }, bounties, splits, stakeRows, mints] =
    await Promise.all([
      loadActiveFarmWeights(),
      loadBountiesByApplicationId(),
      loadMiningCenterSplits({ startTs, endTs }),
      db
        .select()
        .from(gctlStakedByRegionWeek)
        .where(
          and(
            gte(gctlStakedByRegionWeek.weekNumber, params.startWeek),
            lt(gctlStakedByRegionWeek.weekNumber, params.endWeek + 1)
          )
        ),
      db
        .select()
        .from(gctlMintEvents)
        .where(
          and(
            gte(gctlMintEvents.epoch, earliestWeekNeeded),
            lt(gctlMintEvents.epoch, params.endWeek + 1)
          )
        ),
    ]);

  // stakeByWeek[week] => weightsByRegionCode(region => gctlStakedRaw)
  const stakeByWeek = new Map<number, Map<string, bigint>>();
  for (const s of stakeRows) {
    const w = s.weekNumber;
    const map = stakeByWeek.get(w) ?? new Map<string, bigint>();
    map.set(s.region, parseNumericToBigInt(s.gctlStakedRaw));
    stakeByWeek.set(w, map);
  }

  logRegionAlignmentDiagnostics({
    startWeek: params.startWeek,
    endWeek: params.endWeek,
    regionsWithActiveFarms: new Set<string>(Array.from(weightsByRegion.keys())),
    stakeByWeek,
  });

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
  const regionWeekMiner = new Map<string, Map<number, bigint>>();
  const regionWeekMints = new Map<string, Map<number, bigint>>();
  const farmWeekMiner = new Map<string, Map<number, bigint>>();
  const farmWeekMints = new Map<string, Map<number, bigint>>();

  function addToNested(
    outer: Map<string, Map<number, bigint>>,
    key: string,
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
      const region = split.region;
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
            if (b.week < params.startWeek || b.week > params.endWeek) continue;
            addToNested(regionWeekMiner, region, b.week, b.amount);

            const farmWeights = weightsByRegion.get(region);
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
          if (b.week < params.startWeek || b.week > params.endWeek) continue;

          const stakeWeights = stakeByWeek.get(b.week);
          if (!stakeWeights || stakeWeights.size === 0) continue;

          const regionAlloc = allocateAmountByWeights({
            amount: b.amount,
            weightsByKey: stakeWeights,
          });
          for (const [region, regionAmt] of regionAlloc.entries()) {
            addToNested(regionWeekMints, region, b.week, regionAmt);

            const farmWeights = weightsByRegion.get(region);
            if (!farmWeights || farmWeights.size === 0) continue;
            const farmAlloc = allocateAmountByWeights({
              amount: regionAmt,
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

  // Upsert snapshots (delete and re-insert in range for determinism).
  const { regionRows, farmRows } = await db.transaction(async (tx) => {
    await tx
      .delete(polRevenueByRegionWeek)
      .where(
        and(
          gte(polRevenueByRegionWeek.weekNumber, params.startWeek),
          lt(polRevenueByRegionWeek.weekNumber, params.endWeek + 1)
        )
      );
    await tx
      .delete(polRevenueByFarmWeek)
      .where(
        and(
          gte(polRevenueByFarmWeek.weekNumber, params.startWeek),
          lt(polRevenueByFarmWeek.weekNumber, params.endWeek + 1)
        )
      );

    let regionRows = 0;
    for (const [region, byWeekMiner] of regionWeekMiner.entries()) {
      const byWeekMints = regionWeekMints.get(region) ?? new Map<number, bigint>();
      for (let w = params.startWeek; w <= params.endWeek; w++) {
        const miner = byWeekMiner.get(w) ?? 0n;
        const mints = byWeekMints.get(w) ?? 0n;
        const total = miner + mints;
        if (total === 0n) continue;
        await tx.insert(polRevenueByRegionWeek).values({
          weekNumber: w,
          region,
          totalLq: total.toString(),
          minerSalesLq: miner.toString(),
          gctlMintsLq: mints.toString(),
          computedAt: new Date(),
        });
        regionRows++;
      }
    }

    // Regions that only have mints.
    for (const [region, byWeekMints] of regionWeekMints.entries()) {
      if (regionWeekMiner.has(region)) continue;
      for (let w = params.startWeek; w <= params.endWeek; w++) {
        const mints = byWeekMints.get(w) ?? 0n;
        if (mints === 0n) continue;
        await tx.insert(polRevenueByRegionWeek).values({
          weekNumber: w,
          region,
          totalLq: mints.toString(),
          minerSalesLq: "0",
          gctlMintsLq: mints.toString(),
          computedAt: new Date(),
        });
        regionRows++;
      }
    }

    let farmRows = 0;
    const farmIds = new Set<string>([
      ...farmWeekMiner.keys(),
      ...farmWeekMints.keys(),
    ]);
    for (const farmId of Array.from(farmIds)) {
      const byWeekMiner = farmWeekMiner.get(farmId) ?? new Map<number, bigint>();
      const byWeekMints = farmWeekMints.get(farmId) ?? new Map<number, bigint>();
      for (let w = params.startWeek; w <= params.endWeek; w++) {
        const miner = byWeekMiner.get(w) ?? 0n;
        const mints = byWeekMints.get(w) ?? 0n;
        const total = miner + mints;
        if (total === 0n) continue;
        await tx.insert(polRevenueByFarmWeek).values({
          weekNumber: w,
          farmId,
          totalLq: total.toString(),
          minerSalesLq: miner.toString(),
          gctlMintsLq: mints.toString(),
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
  const earliestWeekNeeded = Math.max(0, params.startWeek);
  const startTs = getProtocolWeekStartTimestamp(earliestWeekNeeded);
  const endTs = getProtocolWeekEndTimestamp(params.endWeek);

  const [bounties, splits, mintRows, polYieldRows] = await Promise.all([
    loadBountiesByApplicationId(),
    loadMiningCenterSplits({ startTs, endTs }),
    db
      .select()
      .from(gctlMintEvents)
      .where(
        and(gte(gctlMintEvents.epoch, params.startWeek), lt(gctlMintEvents.epoch, params.endWeek + 1))
      ),
    db
      .select()
      .from(polYieldWeek)
      .where(eq(polYieldWeek.weekNumber, params.endWeek))
      .limit(1),
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
  const yieldSnapshot = polYieldRows[0] ?? null;
  const yieldPerWeekLqAtomic = yieldSnapshot
    ? parseNumericToBigInt(yieldSnapshot.yieldPerWeekLq)
    : 0n;

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
  for (let week = params.startWeek; week <= params.endWeek; week++) {
    upserts.push(
      limit(async () => {
        const spot = await getSpotPriceAtWeekEnd(week);
        const minerUsd = minerUsdByWeek.get(week) ?? 0n;
        const gctlUsd = gctlMintUsdByWeek.get(week) ?? 0n;
        const polYieldUsd = yieldPerWeekLqAtomic
          ? lqAtomicToUsdUsdc6({
              lqAtomic: yieldPerWeekLqAtomic,
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
  // How many epochs to fetch from Control API for staking history.
  stakeEpochs?: number;
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

  const gctlMints = await ingestControlMintEvents();
  const stakeEpochs =
    params?.stakeEpochs ??
    Math.min(Number(process.env.POL_DASHBOARD_STAKE_EPOCHS ?? 260), completedWeek + 1);
  const gctlStake = await ingestControlGctlStakeByRegion({ epochs: stakeEpochs });

  // Default to recomputing a window big enough to cover 10-week buckets and 13-week rollups.
  const hasExistingRevenue =
    (await db
      .select({ c: sql<number>`count(*)` })
      .from(polRevenueByRegionWeek)
      .limit(1)
      .then((r) => Number(r[0]?.c ?? 0))) > 0;

  const startWeek =
    params?.backfillFromWeek ??
    (hasExistingRevenue ? Math.max(0, completedWeek - 40) : 0);
  const endWeek = completedWeek;

  await recomputeRevenueSnapshots({ startWeek, endWeek });

  const fmiStart = Math.max(0, completedWeek - 20);
  await recomputeFmiWeeklyInputs({ startWeek: fmiStart, endWeek });

  return {
    completedWeek,
    polYieldIndexedComplete: polYield.indexingComplete,
    gctlMintsUpserted: gctlMints.upserted,
    gctlStakeUpserted: gctlStake.upserted,
    revenueRange: { startWeek, endWeek },
    fmiRange: { startWeek: fmiStart, endWeek },
  };
}
