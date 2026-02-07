import { describe, expect, it } from "bun:test";
import {
  getGlwVestingBreakdownFromTokenSupply,
  type GlwVestingRules,
} from "../../src/pol/vesting/tokenSupplyVestingSchedule";

describe("GLW vesting breakdown (authoritative investor window)", () => {
  it("keeps investors at 0 until 1y after upgrade and ends Dec 2029 at 180m", () => {
    const rules: GlwVestingRules = {
      // Upgrade on 2026-02-07 -> investor unlock threshold 2027-02-07 -> aligns to 2027-02-19 schedule point.
      contractUpgradeDateIso: "2026-02-07",
      investorUnlockEndIso: "2029-12-19",
      endTotalTokens: 180_000_000n,
    };
    const rows = getGlwVestingBreakdownFromTokenSupply(rules);
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const before = byDate.get("2027-01-19");
    const start = byDate.get("2027-02-19");
    const after = byDate.get("2027-03-19");
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

    // End total is exact.
    expect(end!.total).toBe("180000000");

    // Fully vested investor cap (tokens) from tokenomics (unchanged, just time-shifted).
    expect(end!.ecosystem).toBe("43000000");
    expect(end!.earlyStageFunding).toBe("27050000");
    expect(end!.lateStageFunding).toBe("19950000");
  });
});
