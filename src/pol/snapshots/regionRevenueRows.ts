export type RegionRevenueComponents = {
  weekNumber: number;
  zoneId: number;
  totalLq: bigint;
  minerSalesLq: bigint;
  gctlMintsLq: bigint;
  polYieldLq: bigint;
};

function addAllKeysFromNestedMap(
  out: Set<number>,
  nested: Map<number, Map<number, bigint>>
) {
  for (const k of nested.keys()) out.add(k);
}

export function computeRegionRevenueRows(params: {
  startWeek: number;
  endWeek: number;
  zoneWeekMiner: Map<number, Map<number, bigint>>;
  zoneWeekMints: Map<number, Map<number, bigint>>;
  zoneWeekYield: Map<number, Map<number, bigint>>;
}): RegionRevenueComponents[] {
  const zoneIds = new Set<number>();
  addAllKeysFromNestedMap(zoneIds, params.zoneWeekMiner);
  addAllKeysFromNestedMap(zoneIds, params.zoneWeekMints);
  addAllKeysFromNestedMap(zoneIds, params.zoneWeekYield);

  const rows: RegionRevenueComponents[] = [];
  for (const zoneId of Array.from(zoneIds)) {
    const byWeekMiner = params.zoneWeekMiner.get(zoneId) ?? new Map<number, bigint>();
    const byWeekMints = params.zoneWeekMints.get(zoneId) ?? new Map<number, bigint>();
    const byWeekYield = params.zoneWeekYield.get(zoneId) ?? new Map<number, bigint>();

    for (let w = params.startWeek; w <= params.endWeek; w++) {
      const miner = byWeekMiner.get(w) ?? 0n;
      const mints = byWeekMints.get(w) ?? 0n;
      const yieldLq = byWeekYield.get(w) ?? 0n;
      const total = miner + mints + yieldLq;
      if (total === 0n) continue;
      rows.push({
        weekNumber: w,
        zoneId,
        totalLq: total,
        minerSalesLq: miner,
        gctlMintsLq: mints,
        polYieldLq: yieldLq,
      });
    }
  }

  return rows;
}

