import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { getOrCreateReferralCode } from "../../src/routers/referral-router/helpers/referral-code";
import { db } from "../../src/db/db";
import { referralCodes } from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

function makeTestWallet(): string {
  // Must match `^0x[a-fA-F0-9]{40}$` for any router endpoints that validate.
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

let insertedReferralCodeIds: string[] = [];

describe("Referral Code Generation", () => {
  beforeEach(async () => {
    insertedReferralCodeIds = [];
  });

  afterEach(async () => {
    const uniqueIds = Array.from(new Set(insertedReferralCodeIds));
    if (uniqueIds.length === 0) return;
    await db.delete(referralCodes).where(inArray(referralCodes.id, uniqueIds));
  });

  describe("getOrCreateReferralCode", () => {
    it("creates new code for wallet without existing code", async () => {
      const wallet = makeTestWallet();
      const result = await getOrCreateReferralCode(wallet);
      insertedReferralCodeIds.push(result.id);

      expect(result).toBeDefined();
      expect(result.walletAddress).toBe(wallet.toLowerCase());
      expect(result.code).toBeDefined();
      expect(result.code.length).toBeGreaterThanOrEqual(3);
      expect(result.shareableLink).toBe(`https://app.glow.org/r/${result.code}`);
    });

    it("returns existing code for wallet (idempotent)", async () => {
      const wallet = makeTestWallet();
      // First call creates
      const result1 = await getOrCreateReferralCode(wallet);
      insertedReferralCodeIds.push(result1.id);

      // Second call should return the same
      const result2 = await getOrCreateReferralCode(wallet);

      expect(result1.id).toBe(result2.id);
      expect(result1.code).toBe(result2.code);
      expect(result1.walletAddress).toBe(result2.walletAddress);
    });

    it("normalizes wallet address to lowercase", async () => {
      // Create with mixed case
      const wallet = makeTestWallet();
      const result1 = await getOrCreateReferralCode(
        wallet.toUpperCase().replace("0X", "0x")
      );
      insertedReferralCodeIds.push(result1.id);

      // Retrieve with lowercase
      const result2 = await getOrCreateReferralCode(wallet.toLowerCase());

      expect(result1.id).toBe(result2.id);
    });

    it("creates different codes for different wallets", async () => {
      const wallet1 = makeTestWallet();
      const wallet2 = makeTestWallet();
      const result1 = await getOrCreateReferralCode(wallet1);
      const result2 = await getOrCreateReferralCode(wallet2);
      insertedReferralCodeIds.push(result1.id);
      insertedReferralCodeIds.push(result2.id);

      expect(result1.code).not.toBe(result2.code);
      expect(result1.walletAddress).toBe(wallet1.toLowerCase());
      expect(result2.walletAddress).toBe(wallet2.toLowerCase());
    });

    it("generates shareable link with correct format", async () => {
      const wallet = makeTestWallet();
      const result = await getOrCreateReferralCode(wallet);
      insertedReferralCodeIds.push(result.id);

      expect(result.shareableLink).toMatch(/^https:\/\/app\.glow\.org\/r\/.+$/);
      expect(result.shareableLink).toContain(result.code);
    });

    it("generates code with valid characters (alphanumeric + dots + hyphens)", async () => {
      const wallet = makeTestWallet();
      const result = await getOrCreateReferralCode(wallet);
      insertedReferralCodeIds.push(result.id);

      // Code should be alphanumeric (with possible dots/hyphens for ENS)
      expect(result.code).toMatch(/^[a-zA-Z0-9.-]+$/);
    });
  });

  describe("Code Uniqueness", () => {
    it("ensures one code per wallet (unique constraint)", async () => {
      const wallet = makeTestWallet();
      const record = await getOrCreateReferralCode(wallet);
      insertedReferralCodeIds.push(record.id);

      // Trying to insert directly with same wallet should fail or be handled
      const existingCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(referralCodes)
        .where(eq(referralCodes.walletAddress, wallet.toLowerCase()));

      expect(Number(existingCount[0].count)).toBe(1);
    });

    it("each wallet has unique code", async () => {
      const wallets = [makeTestWallet(), makeTestWallet(), makeTestWallet()];

      const results = await Promise.all(
        wallets.map((w) => getOrCreateReferralCode(w))
      );
      for (const r of results) insertedReferralCodeIds.push(r.id);

      const codes = results.map((r) => r.code);
      const uniqueCodes = new Set(codes);

      expect(uniqueCodes.size).toBe(wallets.length);
    });
  });
});
