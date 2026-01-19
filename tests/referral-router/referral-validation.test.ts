import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  validateReferralLink,
  canClaimReferrer,
  getReferralNonce,
  incrementReferralNonce,
  isValidReferralCode,
  canChangeReferrer,
} from "../../src/routers/referral-router/helpers/referral-validation";
import { db } from "../../src/db/db";
import { referrals, referralCodes, referralNonces, users, Accounts } from "../../src/db/schema";
import { eq } from "drizzle-orm";

// Test wallet addresses
const REFERRER_WALLET = "0x1111111111111111111111111111111111111111";
const REFEREE_WALLET = "0x2222222222222222222222222222222222222222";
const OTHER_WALLET = "0x3333333333333333333333333333333333333333";
const TEST_CODE = "testcode123";

describe("Referral Validation", () => {
  // Clean up test data before/after each test
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe("validateReferralLink", () => {
    it("blocks self-referral", async () => {
      // Setup: Create referral code for the wallet
      await createTestReferralCode(REFERRER_WALLET, TEST_CODE);

      const result = await validateReferralLink({
        referrerWallet: REFERRER_WALLET,
        refereeWallet: REFERRER_WALLET, // Same wallet
        referralCode: TEST_CODE,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Self-referral not allowed");
    });

    it("rejects invalid referral code", async () => {
      const result = await validateReferralLink({
        referrerWallet: REFERRER_WALLET,
        refereeWallet: REFEREE_WALLET,
        referralCode: "nonexistentcode",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("rejects invalid referral code format", async () => {
      const result = await validateReferralLink({
        referrerWallet: REFERRER_WALLET,
        refereeWallet: REFEREE_WALLET,
        referralCode: "bad@code",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code format");
    });

    it("rejects code that belongs to different wallet", async () => {
      // Setup: Create code for OTHER_WALLET
      await createTestReferralCode(OTHER_WALLET, TEST_CODE);

      const result = await validateReferralLink({
        referrerWallet: REFERRER_WALLET, // Claiming it belongs to REFERRER_WALLET
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE, // But it belongs to OTHER_WALLET
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("accepts valid referral link", async () => {
      // Setup: Create code for referrer
      await createTestReferralCode(REFERRER_WALLET, TEST_CODE);

      const result = await validateReferralLink({
        referrerWallet: REFERRER_WALLET,
        refereeWallet: REFEREE_WALLET,
        referralCode: TEST_CODE,
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("isValidReferralCode", () => {
    it("accepts alphanumeric codes 3-32 chars", () => {
      expect(isValidReferralCode("abc")).toBe(true);
      expect(isValidReferralCode("abc123")).toBe(true);
      expect(isValidReferralCode("a".repeat(32))).toBe(true);
    });

    it("accepts ENS-style codes with dots", () => {
      expect(isValidReferralCode("alice.eth")).toBe(true);
      expect(isValidReferralCode("vitalik.eth")).toBe(true);
    });

    it("accepts ENS-style codes with hyphens", () => {
      expect(isValidReferralCode("alice-dev.eth")).toBe(true);
      expect(isValidReferralCode("glow-labs")).toBe(true);
    });

    it("rejects codes that are too short", () => {
      expect(isValidReferralCode("ab")).toBe(false);
      expect(isValidReferralCode("a")).toBe(false);
    });

    it("rejects codes that are too long", () => {
      expect(isValidReferralCode("a".repeat(33))).toBe(false);
    });

    it("rejects codes with special characters", () => {
      expect(isValidReferralCode("test@code")).toBe(false);
      expect(isValidReferralCode("test code")).toBe(false);
    });
  });

  describe("Nonce Management", () => {
    it("starts at 0 for new wallets", async () => {
      const nonce = await getReferralNonce(REFEREE_WALLET);
      expect(nonce).toBe(0);
    });

    it("increments nonce correctly", async () => {
      const nonce1 = await getReferralNonce(REFEREE_WALLET);
      expect(nonce1).toBe(0);

      await incrementReferralNonce(REFEREE_WALLET);
      const nonce2 = await getReferralNonce(REFEREE_WALLET);
      expect(nonce2).toBe(1);

      await incrementReferralNonce(REFEREE_WALLET);
      const nonce3 = await getReferralNonce(REFEREE_WALLET);
      expect(nonce3).toBe(2);
    });

    it("handles case-insensitive wallet addresses", async () => {
      await incrementReferralNonce(REFEREE_WALLET.toLowerCase());
      const nonce = await getReferralNonce(REFEREE_WALLET.toUpperCase().replace("0X", "0x"));
      // Should find the same record
      expect(nonce).toBe(1);
    });
  });

  describe("canClaimReferrer", () => {
    it("allows new users to claim referrer", async () => {
      // No user record, no existing referral
      const result = await canClaimReferrer(REFEREE_WALLET);
      expect(result.canClaim).toBe(true);
    });

    it("blocks change once referral is active (even within grace period)", async () => {
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      await createTestReferral({
        refereeWallet: REFEREE_WALLET,
        referrerWallet: REFERRER_WALLET,
        gracePeriodEndsAt,
        status: "active",
      });

      const result = await canClaimReferrer(REFEREE_WALLET);
      expect(result.canClaim).toBe(false);
      expect(result.reason).toBe("Referrer is already active");
    });

    it("allows change within grace period", async () => {
      // Setup: Create existing referral within grace period
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

      await createTestReferral({
        refereeWallet: REFEREE_WALLET,
        referrerWallet: REFERRER_WALLET,
        gracePeriodEndsAt,
      });

      const result = await canClaimReferrer(REFEREE_WALLET);
      expect(result.canClaim).toBe(true);
      expect(result.gracePeriodEndsAt).toEqual(gracePeriodEndsAt);
    });

    it("blocks change after grace period expires", async () => {
      // Setup: Create existing referral with expired grace period
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

      await createTestReferral({
        refereeWallet: REFEREE_WALLET,
        referrerWallet: REFERRER_WALLET,
        gracePeriodEndsAt,
      });

      const result = await canClaimReferrer(REFEREE_WALLET);
      expect(result.canClaim).toBe(false);
      expect(result.reason).toBe("Referrer is already permanent");
    });
  });

  describe("canChangeReferrer", () => {
    it("returns same result as canClaimReferrer", async () => {
      const claimResult = await canClaimReferrer(REFEREE_WALLET);
      const changeResult = await canChangeReferrer(REFEREE_WALLET);

      expect(changeResult.canChange).toBe(claimResult.canClaim);
      expect(changeResult.reason).toBe(claimResult.reason || "");
    });
  });
});

// ============================================
// Test Helpers
// ============================================

async function cleanupTestData() {
  const testWallets = [REFERRER_WALLET, REFEREE_WALLET, OTHER_WALLET].map((w) =>
    w.toLowerCase()
  );

  // Delete in order to respect foreign key constraints
  for (const wallet of testWallets) {
    await db.delete(referrals).where(eq(referrals.refereeWallet, wallet));
    await db.delete(referralCodes).where(eq(referralCodes.walletAddress, wallet));
    await db.delete(referralNonces).where(eq(referralNonces.walletAddress, wallet));
  }
}

async function createTestReferralCode(wallet: string, code: string) {
  await db.insert(referralCodes).values({
    walletAddress: wallet.toLowerCase(),
    code,
    shareableLink: `https://glow.org/r/${code}`,
  });
}

async function createTestReferral(params: {
  refereeWallet: string;
  referrerWallet: string;
  gracePeriodEndsAt: Date;
  status?: "pending" | "active";
}) {
  const now = new Date();
  await db.insert(referrals).values({
    refereeWallet: params.refereeWallet.toLowerCase(),
    referrerWallet: params.referrerWallet.toLowerCase(),
    referralCode: "test-code",
    linkedAt: now,
    gracePeriodEndsAt: params.gracePeriodEndsAt,
    refereeBonusEndsAt: new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000),
    status: params.status ?? "pending",
  });
}
