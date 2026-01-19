import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/db";
import {
  referrals,
  referralFeatureLaunchSeen,
} from "../../src/db/schema";
import { referralRouter } from "../../src/routers/referral-router/referralRouter";

const REFERRER_WALLET = "0x1111111111111111111111111111111111111111";
const REFEREE_WALLET = "0x2222222222222222222222222222222222222222";
const NO_REFERRAL_WALLET = "0x3333333333333333333333333333333333333333";

function createApp() {
  return new Elysia().use(referralRouter);
}

describe("Referral Feature Launch Tracking", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("stores feature launch seen for wallets without referral records", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/referral/feature-launch-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: NO_REFERRAL_WALLET }),
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);

    const record = await db.query.referralFeatureLaunchSeen.findFirst({
      where: eq(
        referralFeatureLaunchSeen.walletAddress,
        NO_REFERRAL_WALLET.toLowerCase()
      ),
    });
    expect(record).not.toBeNull();

    const statusRes = await app.handle(
      new Request(
        `http://localhost/referral/status?walletAddress=${NO_REFERRAL_WALLET}`
      )
    );
    expect(statusRes.status).toBe(200);
    const statusPayload = await statusRes.json();
    expect(statusPayload.featureLaunchModal?.seen).toBe(true);
    expect(statusPayload.featureLaunchModal?.seenAt).toBeTruthy();
  });

  it("stores feature launch seen on referral records when present", async () => {
    const app = createApp();
    const now = new Date();

    await db.insert(referrals).values({
      refereeWallet: REFEREE_WALLET.toLowerCase(),
      referrerWallet: REFERRER_WALLET.toLowerCase(),
      referralCode: "featuretest",
      linkedAt: now,
      gracePeriodEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      refereeBonusEndsAt: new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000),
      status: "pending",
    });

    const res = await app.handle(
      new Request("http://localhost/referral/feature-launch-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: REFEREE_WALLET }),
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);

    const referral = await db.query.referrals.findFirst({
      where: eq(referrals.refereeWallet, REFEREE_WALLET.toLowerCase()),
    });
    expect(referral?.featureLaunchSeenAt).toBeTruthy();

    const featureSeen = await db.query.referralFeatureLaunchSeen.findFirst({
      where: eq(
        referralFeatureLaunchSeen.walletAddress,
        REFEREE_WALLET.toLowerCase()
      ),
    });
    expect(featureSeen).toBeUndefined();
  });
});

async function cleanupTestData() {
  const wallets = [REFERRER_WALLET, REFEREE_WALLET, NO_REFERRAL_WALLET].map(
    (w) => w.toLowerCase()
  );
  for (const wallet of wallets) {
    await db.delete(referrals).where(eq(referrals.refereeWallet, wallet));
    await db
      .delete(referralFeatureLaunchSeen)
      .where(eq(referralFeatureLaunchSeen.walletAddress, wallet));
  }
}
