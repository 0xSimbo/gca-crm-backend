import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
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

const REFERRER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REFEREE_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function createApp() {
  return new Elysia().use(referralRouter);
}

describe("Referral Status Projection", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("returns projected referee bonus when includeProjection=1", async () => {
    const app = createApp();
    const linkedAt = new Date(0);
    const now = Date.now();

    await db.insert(referrals).values({
      refereeWallet: REFEREE_WALLET.toLowerCase(),
      referrerWallet: REFERRER_WALLET.toLowerCase(),
      referralCode: "projtest",
      linkedAt,
      gracePeriodEndsAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      refereeBonusEndsAt: new Date(now + 12 * 7 * 24 * 60 * 60 * 1000),
      status: "pending",
    });

    const res = await app.handle(
      new Request(
        `http://localhost/referral/status?walletAddress=${REFEREE_WALLET}&includeProjection=1`
      )
    );

    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(payload.bonus?.isActive).toBe(true);
    expect(payload.bonus?.bonusProjectedPointsScaled6).toBe("10");
  });
});

async function cleanupTestData() {
  const wallets = [REFERRER_WALLET, REFEREE_WALLET].map((w) => w.toLowerCase());
  for (const wallet of wallets) {
    await db.delete(referrals).where(eq(referrals.refereeWallet, wallet));
    await db.delete(referrals).where(eq(referrals.referrerWallet, wallet));
  }
}
