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
import { referrals, referralCodes, referralNonces } from "../../src/db/schema";
import { inArray } from "drizzle-orm";

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
let otherWallet = makeTestWallet();

let insertedReferralIds: string[] = [];
let insertedReferralCodeIds: string[] = [];
let insertedNonceWallets: string[] = [];

describe("Referral Validation", () => {
  beforeEach(async () => {
    // Use per-test randomized fixtures to avoid colliding with any real data.
    referrerWallet = makeTestWallet();
    refereeWallet = makeTestWallet();
    otherWallet = makeTestWallet();
    insertedReferralIds = [];
    insertedReferralCodeIds = [];
    insertedNonceWallets = [];
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

  describe("validateReferralLink", () => {
    it("blocks self-referral", async () => {
      // Setup: Create referral code for the wallet
      const testCode = makeTestCode("self");
      await createTestReferralCode(referrerWallet, testCode);

      const result = await validateReferralLink({
        referrerWallet,
        refereeWallet: referrerWallet, // Same wallet
        referralCode: testCode,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Self-referral not allowed");
    });

    it("rejects invalid referral code", async () => {
      const randomCodeNotInserted = makeTestCode("missing");
      const result = await validateReferralLink({
        referrerWallet,
        refereeWallet,
        referralCode: randomCodeNotInserted,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("rejects invalid referral code format", async () => {
      const result = await validateReferralLink({
        referrerWallet,
        refereeWallet,
        referralCode: "bad@code",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code format");
    });

    it("rejects code that belongs to different wallet", async () => {
      // Setup: Create code for OTHER_WALLET
      const testCode = makeTestCode("diff");
      await createTestReferralCode(otherWallet, testCode);

      const result = await validateReferralLink({
        referrerWallet, // Claiming it belongs to referrerWallet
        refereeWallet,
        referralCode: testCode, // But it belongs to otherWallet
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid referral code");
    });

    it("accepts valid referral link", async () => {
      // Setup: Create code for referrer
      const testCode = makeTestCode("ok");
      await createTestReferralCode(referrerWallet, testCode);

      const result = await validateReferralLink({
        referrerWallet,
        refereeWallet,
        referralCode: testCode,
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
      const nonce = await getReferralNonce(refereeWallet);
      expect(nonce).toBe(0);
    });

    it("increments nonce correctly", async () => {
      const nonce1 = await getReferralNonce(refereeWallet);
      expect(nonce1).toBe(0);

      await incrementReferralNonce(refereeWallet);
      insertedNonceWallets.push(refereeWallet);
      const nonce2 = await getReferralNonce(refereeWallet);
      expect(nonce2).toBe(1);

      await incrementReferralNonce(refereeWallet);
      const nonce3 = await getReferralNonce(refereeWallet);
      expect(nonce3).toBe(2);
    });

    it("handles case-insensitive wallet addresses", async () => {
      await incrementReferralNonce(refereeWallet.toLowerCase());
      insertedNonceWallets.push(refereeWallet);
      const nonce = await getReferralNonce(
        refereeWallet.toUpperCase().replace("0X", "0x")
      );
      // Should find the same record
      expect(nonce).toBe(1);
    });
  });

  describe("canClaimReferrer", () => {
    it("allows new users to claim referrer", async () => {
      // No user record, no existing referral
      const result = await canClaimReferrer(refereeWallet);
      expect(result.canClaim).toBe(true);
    });

    it("blocks change once referral is active (even within grace period)", async () => {
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      await createTestReferral({
        refereeWallet,
        referrerWallet,
        gracePeriodEndsAt,
        status: "active",
      });

      const result = await canClaimReferrer(refereeWallet);
      expect(result.canClaim).toBe(false);
      expect(result.reason).toBe("Referrer is already active");
    });

    it("allows change within grace period", async () => {
      // Setup: Create existing referral within grace period
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

      await createTestReferral({
        refereeWallet,
        referrerWallet,
        gracePeriodEndsAt,
      });

      const result = await canClaimReferrer(refereeWallet);
      expect(result.canClaim).toBe(true);
      expect(result.gracePeriodEndsAt).toEqual(gracePeriodEndsAt);
    });

    it("blocks change after grace period expires", async () => {
      // Setup: Create existing referral with expired grace period
      const now = new Date();
      const gracePeriodEndsAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

      await createTestReferral({
        refereeWallet,
        referrerWallet,
        gracePeriodEndsAt,
      });

      const result = await canClaimReferrer(refereeWallet);
      expect(result.canClaim).toBe(false);
      expect(result.reason).toBe("Referrer is already permanent");
    });
  });

  describe("canChangeReferrer", () => {
    it("returns same result as canClaimReferrer", async () => {
      const claimResult = await canClaimReferrer(refereeWallet);
      const changeResult = await canChangeReferrer(refereeWallet);

      expect(changeResult.canChange).toBe(claimResult.canClaim);
      expect(changeResult.reason).toBe(claimResult.reason || "");
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
    .returning({ id: referralCodes.id });
  insertedReferralCodeIds.push(record.id);
}

async function createTestReferral(params: {
  refereeWallet: string;
  referrerWallet: string;
  gracePeriodEndsAt: Date;
  status?: "pending" | "active";
}) {
  const now = new Date();
  const [record] = await db
    .insert(referrals)
    .values({
      refereeWallet: params.refereeWallet.toLowerCase(),
      referrerWallet: params.referrerWallet.toLowerCase(),
      referralCode: makeTestCode("ref"),
      linkedAt: now,
      gracePeriodEndsAt: params.gracePeriodEndsAt,
      refereeBonusEndsAt: new Date(
        now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000
      ),
      status: params.status ?? "pending",
    })
    .returning({ id: referrals.id });
  insertedReferralIds.push(record.id);
}
