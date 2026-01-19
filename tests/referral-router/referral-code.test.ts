import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { getOrCreateReferralCode } from "../../src/routers/referral-router/helpers/referral-code";
import { db } from "../../src/db/db";
import { referralCodes } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";

// Test wallet addresses (using addresses unlikely to have ENS names)
const TEST_WALLET_1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_WALLET_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Referral Code Generation", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe("getOrCreateReferralCode", () => {
    it("creates new code for wallet without existing code", async () => {
      const result = await getOrCreateReferralCode(TEST_WALLET_1);

      expect(result).toBeDefined();
      expect(result.walletAddress).toBe(TEST_WALLET_1.toLowerCase());
      expect(result.code).toBeDefined();
      expect(result.code.length).toBeGreaterThanOrEqual(3);
      expect(result.shareableLink).toBe(`https://app.glow.org/r/${result.code}`);
    });

    it("returns existing code for wallet (idempotent)", async () => {
      // First call creates
      const result1 = await getOrCreateReferralCode(TEST_WALLET_1);

      // Second call should return the same
      const result2 = await getOrCreateReferralCode(TEST_WALLET_1);

      expect(result1.id).toBe(result2.id);
      expect(result1.code).toBe(result2.code);
      expect(result1.walletAddress).toBe(result2.walletAddress);
    });

    it("normalizes wallet address to lowercase", async () => {
      // Create with mixed case
      const result1 = await getOrCreateReferralCode(TEST_WALLET_1.toUpperCase().replace("0X", "0x"));

      // Retrieve with lowercase
      const result2 = await getOrCreateReferralCode(TEST_WALLET_1.toLowerCase());

      expect(result1.id).toBe(result2.id);
    });

    it("creates different codes for different wallets", async () => {
      const result1 = await getOrCreateReferralCode(TEST_WALLET_1);
      const result2 = await getOrCreateReferralCode(TEST_WALLET_2);

      expect(result1.code).not.toBe(result2.code);
      expect(result1.walletAddress).toBe(TEST_WALLET_1.toLowerCase());
      expect(result2.walletAddress).toBe(TEST_WALLET_2.toLowerCase());
    });

    it("generates shareable link with correct format", async () => {
      const result = await getOrCreateReferralCode(TEST_WALLET_1);

      expect(result.shareableLink).toMatch(/^https:\/\/app\.glow\.org\/r\/.+$/);
      expect(result.shareableLink).toContain(result.code);
    });

    it("generates code with valid characters (alphanumeric + dots + hyphens)", async () => {
      const result = await getOrCreateReferralCode(TEST_WALLET_1);

      // Code should be alphanumeric (with possible dots/hyphens for ENS)
      expect(result.code).toMatch(/^[a-zA-Z0-9.-]+$/);
    });
  });

  describe("Code Uniqueness", () => {
    it("ensures one code per wallet (unique constraint)", async () => {
      await getOrCreateReferralCode(TEST_WALLET_1);

      // Trying to insert directly with same wallet should fail or be handled
      const existingCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(referralCodes)
        .where(eq(referralCodes.walletAddress, TEST_WALLET_1.toLowerCase()));

      expect(Number(existingCount[0].count)).toBe(1);
    });

    it("each wallet has unique code", async () => {
      const wallets = [
        "0xcc0000000000000000000000000000000000cccc",
        "0xdd0000000000000000000000000000000000dddd",
        "0xee0000000000000000000000000000000000eeee",
      ];

      const results = await Promise.all(
        wallets.map((w) => getOrCreateReferralCode(w))
      );

      const codes = results.map((r) => r.code);
      const uniqueCodes = new Set(codes);

      expect(uniqueCodes.size).toBe(wallets.length);

      // Cleanup
      for (const w of wallets) {
        await db
          .delete(referralCodes)
          .where(eq(referralCodes.walletAddress, w.toLowerCase()));
      }
    });
  });
});

// ============================================
// Test Helpers
// ============================================

async function cleanupTestData() {
  const testWallets = [TEST_WALLET_1, TEST_WALLET_2].map((w) => w.toLowerCase());

  for (const wallet of testWallets) {
    await db.delete(referralCodes).where(eq(referralCodes.walletAddress, wallet));
  }
}
