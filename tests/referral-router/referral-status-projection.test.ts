import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { Elysia } from "elysia";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/db";
import { referrals } from "../../src/db/schema";

mock.module("../../src/routers/impact-router/helpers/impact-score", () => ({
  computeGlowImpactScores: async () => [
    {
      glowWorth: {
        delegatedActiveGlwWei: "0",
        glowWorthWei: "0",
      },
    },
  ],
  getCurrentWeekProjection: async () => ({
    weekNumber: 200,
    projectedPoints: {
      basePointsPreMultiplierScaled6: "100.000000",
    },
  }),
}));

const { referralRouter } = await import(
  "../../src/routers/referral-router/referralRouter"
);

function makeTestWallet(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function createApp() {
  return new Elysia().use(referralRouter);
}

describe("Referral Status Projection", () => {
  let referrerWallet = makeTestWallet();
  let refereeWallet = makeTestWallet();
  let insertedReferralIds: string[] = [];

  beforeEach(async () => {
    referrerWallet = makeTestWallet();
    refereeWallet = makeTestWallet();
    insertedReferralIds = [];
  });

  afterEach(async () => {
    const ids = Array.from(new Set(insertedReferralIds));
    if (ids.length === 0) return;
    await db.delete(referrals).where(inArray(referrals.id, ids));
  });

  it("returns projected referee bonus when includeProjection=1", async () => {
    const app = createApp();
    const linkedAt = new Date(0);
    const now = Date.now();

    const [record] = await db.insert(referrals).values({
      refereeWallet: refereeWallet.toLowerCase(),
      referrerWallet: referrerWallet.toLowerCase(),
      referralCode: "projtest",
      linkedAt,
      gracePeriodEndsAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      refereeBonusEndsAt: new Date(now + 12 * 7 * 24 * 60 * 60 * 1000),
      status: "pending",
    }).returning({ id: referrals.id });
    insertedReferralIds.push(record.id);

    const res = await app.handle(
      new Request(
        `http://localhost/referral/status?walletAddress=${refereeWallet}&includeProjection=1`
      )
    );

    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(payload.bonus?.isActive).toBe(true);
    expect(payload.bonus?.bonusProjectedPointsScaled6).toBe("10");
  });
});
