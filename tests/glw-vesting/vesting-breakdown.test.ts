import { describe, expect, it } from "bun:test";
import { getGlwVestingBreakdownFromTokenSupply } from "../../src/pol/vesting/tokenSupplyVestingSchedule";

describe("GLW vesting breakdown (authoritative investor window)", () => {
  it("keeps early investors (ecosystem/early/late) at 0 until Dec 2026 and fully unlocks by Dec 2029", () => {
    const rows = getGlwVestingBreakdownFromTokenSupply();
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const before = byDate.get("2026-11-19");
    const start = byDate.get("2026-12-19");
    const after = byDate.get("2027-01-19");
    const end = byDate.get("2029-12-19");

    expect(before).toBeTruthy();
    expect(start).toBeTruthy();
    expect(after).toBeTruthy();
    expect(end).toBeTruthy();

    for (const r of [before!, start!]) {
      expect(r.ecosystem).toBe("0");
      expect(r.earlyStageFunding).toBe("0");
      expect(r.lateStageFunding).toBe("0");
    }

    expect(BigInt(after!.ecosystem)).toBeGreaterThan(0n);
    expect(BigInt(after!.earlyStageFunding)).toBeGreaterThan(0n);
    expect(BigInt(after!.lateStageFunding)).toBeGreaterThan(0n);

    // Fully vested allocations (tokens) from tokenomics.
    expect(end!.ecosystem).toBe("43000000");
    expect(end!.earlyStageFunding).toBe("27050000");
    expect(end!.lateStageFunding).toBe("19950000");
  });
});

