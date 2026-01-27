import { describe, expect, it } from "bun:test";
import {
  calculateReferrerShare,
  calculateRefereeBonus,
  calculateRefereeActivationBonus,
  applyPostLinkProration,
  combineRefereeBonusPointsScaled6,
  getReferrerTier,
  isWithinBonusPeriod,
} from "../../src/routers/impact-router/helpers/referral-points";
import { GENESIS_TIMESTAMP } from "../../src/constants/genesis-timestamp";

describe("Referral Point Calculation", () => {
  it("calculates tiered referrer share based on active referral count", () => {
    const refereeBasePoints = 1000_000000n; // 1000 points scaled6
    const referrerBasePoints = 1_000000n; // Any positive base points

    // None (0 refs): 0%
    expect(
      calculateReferrerShare(refereeBasePoints, 0, referrerBasePoints)
    ).toBe(0n);

    // Seed tier (1 ref): 5%
    expect(
      calculateReferrerShare(refereeBasePoints, 1, referrerBasePoints)
    ).toBe(50_000000n);

    // Grow tier (2-3 refs): 10%
    expect(
      calculateReferrerShare(refereeBasePoints, 2, referrerBasePoints)
    ).toBe(100_000000n);
    expect(
      calculateReferrerShare(refereeBasePoints, 3, referrerBasePoints)
    ).toBe(100_000000n);

    // Scale tier (4-6 refs): 15%
    expect(
      calculateReferrerShare(refereeBasePoints, 4, referrerBasePoints)
    ).toBe(150_000000n);
    expect(
      calculateReferrerShare(refereeBasePoints, 6, referrerBasePoints)
    ).toBe(150_000000n);

    // Legend tier (7+ refs): 20%
    expect(
      calculateReferrerShare(refereeBasePoints, 7, referrerBasePoints)
    ).toBe(200_000000n);
    expect(
      calculateReferrerShare(refereeBasePoints, 15, referrerBasePoints)
    ).toBe(200_000000n);
  });

  it("does not increase tier when referrer has zero base points", () => {
    const refereeBasePoints = 1000_000000n;

    expect(calculateReferrerShare(refereeBasePoints, 7, 0n)).toBe(0n);

    const tier = getReferrerTier(7, 0n);
    expect(tier.name).toBe("Seed");
    expect(tier.percent).toBe(0);
  });

  it("calculates 10% bonus for referee", () => {
    const refereeBasePoints = 1000_000000n;
    const expectedBonus = 100_000000n; // 10% of 1000

    expect(calculateRefereeBonus(refereeBasePoints)).toBe(expectedBonus);
  });

  it("awards 100pt activation bonus", () => {
    expect(calculateRefereeActivationBonus()).toBe(100_000000n);
  });

  it("includes activation bonus in lifetime referee bonus totals", () => {
    const combined = combineRefereeBonusPointsScaled6({
      referralBonusPointsScaled6: "42.000000",
      activationBonusAwarded: true,
    });
    expect(combined).toBe("142");
  });

  it("identifies correct tier info", () => {
    const tier0 = getReferrerTier(0, 1_000000n);
    expect(tier0.name).toBe("Seed");
    expect(tier0.percent).toBe(0);
    expect(tier0.nextTier?.name).toBe("Grow");
    expect(tier0.nextTier?.referralsNeeded).toBe(2);

    const tier1 = getReferrerTier(1, 1_000000n);
    expect(tier1.name).toBe("Seed");
    expect(tier1.percent).toBe(5);
    expect(tier1.nextTier?.name).toBe("Grow");
    expect(tier1.nextTier?.referralsNeeded).toBe(1);

    const tier3 = getReferrerTier(3, 1_000000n);
    expect(tier3.name).toBe("Grow");
    expect(tier3.percent).toBe(10);
    expect(tier3.nextTier?.name).toBe("Scale");
    expect(tier3.nextTier?.referralsNeeded).toBe(1);

    const tier7 = getReferrerTier(7, 1_000000n);
    expect(tier7.name).toBe("Legend");
    expect(tier7.percent).toBe(20);
    expect(tier7.nextTier).toBeUndefined();
  });

  it("checks bonus period correctly", () => {
    const bonusEndsAt = new Date("2026-03-15T00:00:00Z");
    
    // Within period
    expect(isWithinBonusPeriod({
      refereeBonusEndsAt: bonusEndsAt,
      weekEndTimestamp: Math.floor(new Date("2026-03-14T23:59:59Z").getTime() / 1000)
    })).toBe(true);

    // At exact end
    expect(isWithinBonusPeriod({
      refereeBonusEndsAt: bonusEndsAt,
      weekEndTimestamp: Math.floor(bonusEndsAt.getTime() / 1000)
    })).toBe(true);

    // Outside period
    expect(isWithinBonusPeriod({
      refereeBonusEndsAt: bonusEndsAt,
      weekEndTimestamp: Math.floor(new Date("2026-03-15T00:00:01Z").getTime() / 1000)
    })).toBe(false);
  });

  it("prorates base points for mid-week links", () => {
    const weekNumber = 10;
    const weekStart = GENESIS_TIMESTAMP + weekNumber * 7 * 24 * 60 * 60;
    const midWeek = new Date((weekStart + 3 * 24 * 60 * 60) * 1000);
    const basePoints = 100_000000n;

    const prorated = applyPostLinkProration({
      basePointsScaled6: basePoints,
      linkedAt: midWeek,
      weekNumber,
    });

    expect(prorated).toBe((basePoints * 4n) / 7n);
  });

  it("keeps full points when linked before week start", () => {
    const weekNumber = 5;
    const weekStart = GENESIS_TIMESTAMP + weekNumber * 7 * 24 * 60 * 60;
    const beforeWeek = new Date((weekStart - 60) * 1000);
    const basePoints = 50_000000n;

    const prorated = applyPostLinkProration({
      basePointsScaled6: basePoints,
      linkedAt: beforeWeek,
      weekNumber,
    });

    expect(prorated).toBe(basePoints);
  });
});
