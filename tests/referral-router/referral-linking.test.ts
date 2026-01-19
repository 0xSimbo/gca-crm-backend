import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { linkReferrer } from "../../src/routers/referral-router/helpers/referral-linking";
import { db } from "../../src/db/db";
import { referrals, referralCodes, referralNonces } from "../../src/db/schema";
import { eq } from "drizzle-orm";

// Test wallet addresses
const REFERRER_WALLET = "0x4444444444444444444444444444444444444444";
const REFEREE_WALLET = "0x5555555555555555555555555555555555555555";
const NEW_REFERRER_WALLET = "0x6666666666666666666666666666666666666666";
const TEST_CODE = "linktest123";
const NEW_TEST_CODE = "newcode456";

describe("Referral Linking", () => {
  beforeEach(async () => {
    await cleanupTestData();
    // Setup referral codes for referrers
    await createTestReferralCode(REFERRER_WALLET, TEST_CODE);
    await createTestReferralCode(NEW_REFERRER_WALLET, NEW_TEST_CODE);
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe("linkReferrer - New Referral", () => {
    it("creates new referral with correct fields", async () => {
      const result = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      expect(result.referrerWallet).toBe(REFERRER_WALLET.toLowerCase());
      expect(result.refereeWallet).toBe(REFEREE_WALLET.toLowerCase());
      expect(result.referralCode).toBe(TEST_CODE);
      expect(result.status).toBe("pending");
      expect(result.previousReferrerWallet).toBeNull();
    });

    it("sets grace period to 7 days from now", async () => {
      const before = Date.now();
      const result = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });
      const after = Date.now();

      const expectedGracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      const gracePeriodMs = result.gracePeriodEndsAt.getTime() - result.linkedAt.getTime();

      // Grace period should be approximately 7 days (allow 1 second tolerance)
      expect(gracePeriodMs).toBeGreaterThanOrEqual(expectedGracePeriod - 1000);
      expect(gracePeriodMs).toBeLessThanOrEqual(expectedGracePeriod + 1000);
    });

    it("sets bonus period to 12 weeks from now", async () => {
      const result = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      const expectedBonusPeriod = 12 * 7 * 24 * 60 * 60 * 1000; // 12 weeks in ms
      const bonusPeriodMs = result.refereeBonusEndsAt.getTime() - result.linkedAt.getTime();

      expect(bonusPeriodMs).toBeGreaterThanOrEqual(expectedBonusPeriod - 1000);
      expect(bonusPeriodMs).toBeLessThanOrEqual(expectedBonusPeriod + 1000);
    });

    it("increments nonce after successful link", async () => {
      await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      const nonceRecord = await db.query.referralNonces.findFirst({
        where: eq(referralNonces.walletAddress, REFEREE_WALLET.toLowerCase()),
      });

      expect(nonceRecord?.nonce).toBe(1);
    });
  });

  describe("linkReferrer - Validation Errors", () => {
    it("rejects invalid nonce", async () => {
      await expect(
        linkReferrer({
          refereeWallet: REFEREE_WALLET,
          referralCode: TEST_CODE,
          referrerWallet: REFERRER_WALLET,
          nonce: "999", // Wrong nonce
        })
      ).rejects.toThrow("Invalid nonce");
    });

    it("rejects self-referral", async () => {
      // Create code for referee wallet
      await createTestReferralCode(REFEREE_WALLET, "selfcode");

      await expect(
        linkReferrer({
          refereeWallet: REFEREE_WALLET,
          referralCode: "selfcode",
          referrerWallet: REFEREE_WALLET, // Same as referee
          nonce: "0",
        })
      ).rejects.toThrow("Self-referral not allowed");
    });

    it("rejects invalid referral code", async () => {
      await expect(
        linkReferrer({
          refereeWallet: REFEREE_WALLET,
          referralCode: "nonexistent",
          referrerWallet: REFERRER_WALLET,
          nonce: "0",
        })
      ).rejects.toThrow("Invalid referral code");
    });
  });

  describe("linkReferrer - Referrer Change (Within Grace Period)", () => {
    it("allows changing referrer within grace period", async () => {
      // First link
      await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      // Change to new referrer (nonce is now 1)
      const result = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: NEW_TEST_CODE,
        referrerWallet: NEW_REFERRER_WALLET,
        nonce: "1",
      });

      expect(result.referrerWallet).toBe(NEW_REFERRER_WALLET.toLowerCase());
      expect(result.previousReferrerWallet).toBe(REFERRER_WALLET.toLowerCase());
      expect(result.referrerChangedAt).not.toBeNull();
    });

    it("does not reset grace period or bonus window on change", async () => {
      const first = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      const updated = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: NEW_TEST_CODE,
        referrerWallet: NEW_REFERRER_WALLET,
        nonce: "1",
      });

      expect(updated.linkedAt.getTime()).toBe(first.linkedAt.getTime());
      expect(updated.gracePeriodEndsAt.getTime()).toBe(first.gracePeriodEndsAt.getTime());
      expect(updated.refereeBonusEndsAt.getTime()).toBe(first.refereeBonusEndsAt.getTime());
    });

    it("tracks previous referrer on change", async () => {
      // First link
      await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      // Change
      const result = await linkReferrer({
        refereeWallet: REFEREE_WALLET,
        referralCode: NEW_TEST_CODE,
        referrerWallet: NEW_REFERRER_WALLET,
        nonce: "1",
      });

      expect(result.previousReferrerWallet).toBe(REFERRER_WALLET.toLowerCase());
    });
  });

  describe("linkReferrer - Referrer Change (After Grace Period)", () => {
    it("rejects change after grace period expires", async () => {
      // Create referral with expired grace period
      const now = new Date();
      const expiredGracePeriod = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

      await db.insert(referrals).values({
        refereeWallet: REFEREE_WALLET.toLowerCase(),
        referrerWallet: REFERRER_WALLET.toLowerCase(),
        referralCode: TEST_CODE,
        linkedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
        gracePeriodEndsAt: expiredGracePeriod,
        refereeBonusEndsAt: new Date(now.getTime() + 11 * 7 * 24 * 60 * 60 * 1000),
        status: "pending",
      });

      await expect(
        linkReferrer({
          refereeWallet: REFEREE_WALLET,
          referralCode: NEW_TEST_CODE,
          referrerWallet: NEW_REFERRER_WALLET,
          nonce: "0",
        })
      ).rejects.toThrow("Referrer is already permanent");
    });
  });

  describe("Multiple Referees Same Code", () => {
    it("allows multiple referees to use same referrer code", async () => {
      const referee1 = "0x7777777777777777777777777777777777777777";
      const referee2 = "0x8888888888888888888888888888888888888888";

      // First referee uses the code
      const result1 = await linkReferrer({
        refereeWallet: referee1,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      // Second referee uses the same code
      const result2 = await linkReferrer({
        refereeWallet: referee2,
        referralCode: TEST_CODE,
        referrerWallet: REFERRER_WALLET,
        nonce: "0",
      });

      expect(result1.referrerWallet).toBe(REFERRER_WALLET.toLowerCase());
      expect(result2.referrerWallet).toBe(REFERRER_WALLET.toLowerCase());
      expect(result1.refereeWallet).toBe(referee1.toLowerCase());
      expect(result2.refereeWallet).toBe(referee2.toLowerCase());

      // Cleanup these additional test wallets
      await db.delete(referrals).where(eq(referrals.refereeWallet, referee1.toLowerCase()));
      await db.delete(referrals).where(eq(referrals.refereeWallet, referee2.toLowerCase()));
      await db.delete(referralNonces).where(eq(referralNonces.walletAddress, referee1.toLowerCase()));
      await db.delete(referralNonces).where(eq(referralNonces.walletAddress, referee2.toLowerCase()));
    });
  });
});

// ============================================
// Test Helpers
// ============================================

async function cleanupTestData() {
  const testWallets = [REFERRER_WALLET, REFEREE_WALLET, NEW_REFERRER_WALLET].map(
    (w) => w.toLowerCase()
  );

  for (const wallet of testWallets) {
    await db.delete(referrals).where(eq(referrals.refereeWallet, wallet));
    await db.delete(referralCodes).where(eq(referralCodes.walletAddress, wallet));
    await db.delete(referralNonces).where(eq(referralNonces.walletAddress, wallet));
  }
}

async function createTestReferralCode(wallet: string, code: string) {
  await db
    .insert(referralCodes)
    .values({
      walletAddress: wallet.toLowerCase(),
      code,
      shareableLink: `https://glow.org/r/${code}`,
    })
    .onConflictDoNothing();
}
