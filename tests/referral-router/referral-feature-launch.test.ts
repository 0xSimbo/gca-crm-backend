import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/db";
import {
  referrals,
  referralFeatureLaunchSeen,
} from "../../src/db/schema";
import { referralRouter } from "../../src/routers/referral-router/referralRouter";

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

describe("Referral Feature Launch Tracking", () => {
  let referrerWallet = makeTestWallet();
  let refereeWallet = makeTestWallet();
  let noReferralWallet = makeTestWallet();

  let insertedReferralIds: string[] = [];
  let insertedFeatureSeenWallets: string[] = [];

  beforeEach(async () => {
    referrerWallet = makeTestWallet();
    refereeWallet = makeTestWallet();
    noReferralWallet = makeTestWallet();
    insertedReferralIds = [];
    insertedFeatureSeenWallets = [];
  });

  afterEach(async () => {
    const referralIds = Array.from(new Set(insertedReferralIds));
    const seenWallets = Array.from(new Set(insertedFeatureSeenWallets)).map((w) =>
      w.toLowerCase()
    );

    if (referralIds.length > 0) {
      await db.delete(referrals).where(inArray(referrals.id, referralIds));
    }
    if (seenWallets.length > 0) {
      await db
        .delete(referralFeatureLaunchSeen)
        .where(inArray(referralFeatureLaunchSeen.walletAddress, seenWallets));
    }
  });

  it("stores feature launch seen for wallets without referral records", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/referral/feature-launch-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: noReferralWallet }),
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);

    const record = await db.query.referralFeatureLaunchSeen.findFirst({
      where: eq(
        referralFeatureLaunchSeen.walletAddress,
        noReferralWallet.toLowerCase()
      ),
    });
    expect(record).not.toBeNull();
    insertedFeatureSeenWallets.push(noReferralWallet);

    const statusRes = await app.handle(
      new Request(
        `http://localhost/referral/status?walletAddress=${noReferralWallet}`
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

    const [record] = await db.insert(referrals).values({
      refereeWallet: refereeWallet.toLowerCase(),
      referrerWallet: referrerWallet.toLowerCase(),
      referralCode: "featuretest",
      linkedAt: now,
      gracePeriodEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      refereeBonusEndsAt: new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000),
      status: "pending",
    }).returning({ id: referrals.id });
    insertedReferralIds.push(record.id);

    const res = await app.handle(
      new Request("http://localhost/referral/feature-launch-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: refereeWallet }),
      })
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);

    const referral = await db.query.referrals.findFirst({
      where: eq(referrals.refereeWallet, refereeWallet.toLowerCase()),
    });
    expect(referral?.featureLaunchSeenAt).toBeTruthy();

    const featureSeen = await db.query.referralFeatureLaunchSeen.findFirst({
      where: eq(
        referralFeatureLaunchSeen.walletAddress,
        refereeWallet.toLowerCase()
      ),
    });
    expect(featureSeen).toBeUndefined();
  });
});
