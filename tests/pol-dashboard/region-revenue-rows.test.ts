import { describe, expect, it } from "bun:test";
import { computeRegionRevenueRows } from "../../src/pol/snapshots/regionRevenueRows";

describe("PoL Dashboard: region revenue rows", () => {
  it("includes zones that have both mints and yield but no miner sales", () => {
    const zoneWeekMiner = new Map<number, Map<number, bigint>>();
    const zoneWeekMints = new Map<number, Map<number, bigint>>([
      [1, new Map([[100, 10n]])],
      [2, new Map([[100, 20n]])],
    ]);
    const zoneWeekYield = new Map<number, Map<number, bigint>>([
      [1, new Map([[100, 1n]])],
      [2, new Map([[100, 2n]])],
    ]);

    const rows = computeRegionRevenueRows({
      startWeek: 100,
      endWeek: 100,
      zoneWeekMiner,
      zoneWeekMints,
      zoneWeekYield,
    });

    const z1 = rows.find((r) => r.zoneId === 1);
    const z2 = rows.find((r) => r.zoneId === 2);
    expect(z1).toBeTruthy();
    expect(z2).toBeTruthy();
    expect(z1?.totalLq).toBe(11n);
    expect(z2?.totalLq).toBe(22n);
  });
});

