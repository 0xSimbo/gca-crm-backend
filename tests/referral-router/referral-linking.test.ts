import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { linkReferrer } from "../../src/routers/referral-router/helpers/referral-linking";
import { db } from "../../src/db/db";
import { referrals, referralCodes, referralNonces } from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";

function makeTestWallet(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

function makeTestCode(prefix = "t"): string {
  // Must match `^[a-zA-Z0-9.-]{3,32}$`
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  return `${prefix}${suffix}`.slice(0, 32);
}

let referrerWallet = makeTestWallet();
let refereeWallet = makeTestWallet();
let newReferrerWallet = makeTestWallet();
let testCode = makeTestCode("link");
let newTestCode = makeTestCode("new");

let insertedReferralIds: string[] = [];
let insertedReferralCodeIds: string[] = [];
let insertedNonceWallets: string[] = [];

describe("Referral Linking", () => {
  beforeEach(async () => {
    referrerWallet = makeTestWallet();
    refereeWallet = makeTestWallet();
    newReferrerWallet = makeTestWallet();
    testCode = makeTestCode("link");
    newTestCode = makeTestCode("new");
    insertedReferralIds = [];
    insertedReferralCodeIds = [];
    insertedNonceWallets = [];

    // Setup referral codes for referrers
    await createTestReferralCode(referrerWallet, testCode);
    await createTestReferralCode(newReferrerWallet, newTestCode);
  });

  afterEach(async () => {
    const referralIds = Array.from(new Set(insertedReferralIds));
    const codeIds = Array.from(new Set(insertedReferralCodeIds));
    const nonceWallets = Array.from(new Set(insertedNonceWallets)).map((w) =>
      w.toLowerCase()
    );

    if (referralIds.length > 0) {
      await db.delete(referrals).where(inArray(referrals.id, referralIds));
    }
    if (codeIds.length > 0) {
      await db
        .delete(referralCodes)
        .where(inArray(referralCodes.id, codeIds));
    }
    if (nonceWallets.length > 0) {
      await db
        .delete(referralNonces)
        .where(inArray(referralNonces.walletAddress, nonceWallets));
    }
  });

  describe("linkReferrer - New Referral", () => {
    it("creates new referral with correct fields", async () => {
      const result = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });

      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      expect(result.referrerWallet).toBe(referrerWallet.toLowerCase());
      expect(result.refereeWallet).toBe(refereeWallet.toLowerCase());
      expect(result.referralCode).toBe(testCode);
      expect(result.status).toBe("pending");
      expect(result.previousReferrerWallet).toBeNull();
    });

    it("sets grace period to 7 days from now", async () => {
      const before = Date.now();
      const result = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      const after = Date.now();
      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      const expectedGracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      const gracePeriodMs = result.gracePeriodEndsAt.getTime() - result.linkedAt.getTime();

      // Grace period should be approximately 7 days (allow 1 second tolerance)
      expect(gracePeriodMs).toBeGreaterThanOrEqual(expectedGracePeriod - 1000);
      expect(gracePeriodMs).toBeLessThanOrEqual(expectedGracePeriod + 1000);
    });

    it("sets bonus period to 12 weeks from now", async () => {
      const result = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      const expectedBonusPeriod = 12 * 7 * 24 * 60 * 60 * 1000; // 12 weeks in ms
      const bonusPeriodMs = result.refereeBonusEndsAt.getTime() - result.linkedAt.getTime();

      expect(bonusPeriodMs).toBeGreaterThanOrEqual(expectedBonusPeriod - 1000);
      expect(bonusPeriodMs).toBeLessThanOrEqual(expectedBonusPeriod + 1000);
    });

    it("increments nonce after successful link", async () => {
      const result = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      const nonceRecord = await db.query.referralNonces.findFirst({
        where: eq(referralNonces.walletAddress, refereeWallet.toLowerCase()),
      });

      expect(nonceRecord?.nonce).toBe(1);
    });
  });

  describe("linkReferrer - Validation Errors", () => {
    it("rejects invalid nonce", async () => {
      await expect(
        linkReferrer({
          refereeWallet,
          referralCode: testCode,
          referrerWallet,
          nonce: "999", // Wrong nonce
        })
      ).rejects.toThrow("Invalid nonce");
    });

    it("rejects self-referral", async () => {
      // Create code for referee wallet
      const selfCode = makeTestCode("self");
      await createTestReferralCode(refereeWallet, selfCode);

      await expect(
        linkReferrer({
          refereeWallet,
          referralCode: selfCode,
          referrerWallet: refereeWallet, // Same as referee
          nonce: "0",
        })
      ).rejects.toThrow("Self-referral not allowed");
    });

    it("rejects invalid referral code", async () => {
      const missingCode = makeTestCode("missing");
      await expect(
        linkReferrer({
          refereeWallet,
          referralCode: missingCode,
          referrerWallet,
          nonce: "0",
        })
      ).rejects.toThrow("Invalid referral code");
    });
  });

  describe("linkReferrer - Referrer Change (Within Grace Period)", () => {
    it("allows changing referrer within grace period", async () => {
      // First link
      const first = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(first.id);
      insertedNonceWallets.push(refereeWallet);

      // Change to new referrer (nonce is now 1)
      const result = await linkReferrer({
        refereeWallet,
        referralCode: newTestCode,
        referrerWallet: newReferrerWallet,
        nonce: "1",
      });
      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      expect(result.referrerWallet).toBe(newReferrerWallet.toLowerCase());
      expect(result.previousReferrerWallet).toBe(referrerWallet.toLowerCase());
      expect(result.referrerChangedAt).not.toBeNull();
    });

    it("does not reset grace period or bonus window on change", async () => {
      const first = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(first.id);
      insertedNonceWallets.push(refereeWallet);

      const updated = await linkReferrer({
        refereeWallet,
        referralCode: newTestCode,
        referrerWallet: newReferrerWallet,
        nonce: "1",
      });
      insertedReferralIds.push(updated.id);
      insertedNonceWallets.push(refereeWallet);

      expect(updated.linkedAt.getTime()).toBe(first.linkedAt.getTime());
      expect(updated.gracePeriodEndsAt.getTime()).toBe(first.gracePeriodEndsAt.getTime());
      expect(updated.refereeBonusEndsAt.getTime()).toBe(first.refereeBonusEndsAt.getTime());
    });

    it("tracks previous referrer on change", async () => {
      // First link
      const first = await linkReferrer({
        refereeWallet,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(first.id);
      insertedNonceWallets.push(refereeWallet);

      // Change
      const result = await linkReferrer({
        refereeWallet,
        referralCode: newTestCode,
        referrerWallet: newReferrerWallet,
        nonce: "1",
      });
      insertedReferralIds.push(result.id);
      insertedNonceWallets.push(refereeWallet);

      expect(result.previousReferrerWallet).toBe(referrerWallet.toLowerCase());
    });
  });

  describe("linkReferrer - Referrer Change (After Grace Period)", () => {
    it("rejects change after grace period expires", async () => {
      // Create referral with expired grace period
      const now = new Date();
      const expiredGracePeriod = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

      const [record] = await db
        .insert(referrals)
        .values({
          refereeWallet: refereeWallet.toLowerCase(),
          referrerWallet: referrerWallet.toLowerCase(),
          referralCode: testCode,
          linkedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
          gracePeriodEndsAt: expiredGracePeriod,
          refereeBonusEndsAt: new Date(
            now.getTime() + 11 * 7 * 24 * 60 * 60 * 1000
          ),
          status: "pending",
        })
        .returning({ id: referrals.id });
      insertedReferralIds.push(record.id);

      await expect(
        linkReferrer({
          refereeWallet,
          referralCode: newTestCode,
          referrerWallet: newReferrerWallet,
          nonce: "0",
        })
      ).rejects.toThrow("Referrer is already permanent");
    });
  });

  describe("Multiple Referees Same Code", () => {
    it("allows multiple referees to use same referrer code", async () => {
      const referee1 = makeTestWallet();
      const referee2 = makeTestWallet();

      // First referee uses the code
      const result1 = await linkReferrer({
        refereeWallet: referee1,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(result1.id);
      insertedNonceWallets.push(referee1);

      // Second referee uses the same code
      const result2 = await linkReferrer({
        refereeWallet: referee2,
        referralCode: testCode,
        referrerWallet,
        nonce: "0",
      });
      insertedReferralIds.push(result2.id);
      insertedNonceWallets.push(referee2);

      expect(result1.referrerWallet).toBe(referrerWallet.toLowerCase());
      expect(result2.referrerWallet).toBe(referrerWallet.toLowerCase());
      expect(result1.refereeWallet).toBe(referee1.toLowerCase());
      expect(result2.refereeWallet).toBe(referee2.toLowerCase());
    });
  });
});

async function createTestReferralCode(wallet: string, code: string) {
  const [record] = await db
    .insert(referralCodes)
    .values({
      walletAddress: wallet.toLowerCase(),
      code,
      shareableLink: `https://glow.org/r/${code}`,
    })
    .onConflictDoNothing()
    .returning({ id: referralCodes.id });
  if (record) insertedReferralCodeIds.push(record.id);
}
