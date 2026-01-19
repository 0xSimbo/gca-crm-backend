import { describe, expect, it } from "bun:test";
import {
  ACTIVATION_THRESHOLD_SCALED6,
  buildActiveReferralCountMap,
  findActivationCandidates,
  getPostLinkBasePointsScaled6,
  type ReferralSnapshot,
} from "../../src/crons/update-impact-leaderboard/referral-cron-helpers";
import { calculateReferrerShare } from "../../src/routers/impact-router/helpers/referral-points";

describe("Referral Cron Helpers", () => {
  it("excludes pre-link points from activation totals", () => {
    const postLinkPoints = getPostLinkBasePointsScaled6({
      historicalBasePointsScaled6: 80_000000n,
      basePointsThisWeekScaled6: 30_000000n,
      activationStartWeek: 120,
      endWeek: 120,
    });
    expect(postLinkPoints).toBe(110_000000n);

    const beforeLink = getPostLinkBasePointsScaled6({
      historicalBasePointsScaled6: 80_000000n,
      basePointsThisWeekScaled6: 30_000000n,
      activationStartWeek: 121,
      endWeek: 120,
    });
    expect(beforeLink).toBe(0n);
  });

  it("finds activation candidates based on post-link base points", () => {
    const referrals: ReferralSnapshot[] = [
      {
        id: "r1",
        status: "pending",
        activationBonusAwarded: false,
        referrerWallet: "0xreferrer",
        refereeWallet: "0xreferee1",
      },
      {
        id: "r2",
        status: "pending",
        activationBonusAwarded: true,
        referrerWallet: "0xreferrer",
        refereeWallet: "0xreferee2",
      },
      {
        id: "r3",
        status: "active",
        activationBonusAwarded: true,
        referrerWallet: "0xreferrer",
        refereeWallet: "0xreferee3",
      },
    ];

    const basePointsThisWeekByReferee = new Map<string, bigint>([
      ["0xreferee1", 40_000000n],
      ["0xreferee2", 150_000000n],
      ["0xreferee3", 10_000000n],
    ]);
    const historicalBasePointsByReferee = new Map<string, bigint>([
      ["0xreferee1", 70_000000n],
      ["0xreferee2", 0n],
      ["0xreferee3", 0n],
    ]);
    const activationStartWeekByReferee = new Map<string, number>([
      ["0xreferee1", 110],
      ["0xreferee2", 110],
      ["0xreferee3", 110],
    ]);

    const candidates = findActivationCandidates({
      referrals,
      basePointsThisWeekByReferee,
      historicalBasePointsByReferee,
      activationStartWeekByReferee,
      endWeek: 120,
    });

    expect(candidates.has("r1")).toBe(true);
    expect(candidates.has("r2")).toBe(false);
    expect(candidates.has("r3")).toBe(false);
    expect(
      basePointsThisWeekByReferee.get("0xreferee1")! +
        historicalBasePointsByReferee.get("0xreferee1")!
    ).toBeGreaterThanOrEqual(ACTIVATION_THRESHOLD_SCALED6);
  });

  it("stabilizes tier counts when multiple activations occur", () => {
    const referrals: ReferralSnapshot[] = [
      {
        id: "a1",
        status: "pending",
        activationBonusAwarded: false,
        referrerWallet: "0xreferrer",
        refereeWallet: "0xreferee1",
      },
      {
        id: "a2",
        status: "pending",
        activationBonusAwarded: false,
        referrerWallet: "0xreferrer",
        refereeWallet: "0xreferee2",
      },
    ];

    const activationCandidates = new Set<string>(["a1", "a2"]);
    const activeCounts = buildActiveReferralCountMap({
      referrals,
      activationCandidates,
    });

    const activeCount = activeCounts.get("0xreferrer") || 0;
    const share = calculateReferrerShare(100_000000n, activeCount);

    expect(activeCount).toBe(2);
    expect(share).toBe(10_000000n);
  });
});
