import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { wallets } from "../../schema";

/**
 * Increments and returns the next nonce for a wallet
 * This is atomic to prevent race conditions
 *
 * @param walletAddress - The wallet address
 * @returns The next nonce value
 */
export async function getNextWalletNonce(
  walletAddress: string
): Promise<number> {
  const result = await db
    .update(wallets)
    .set({
      fractionNonce: sql`${wallets.fractionNonce} + 1`,
    })
    .where(eq(wallets.id, walletAddress.toLowerCase()))
    .returning({ nonce: wallets.fractionNonce });

  if (result.length === 0) {
    // Wallet doesn't exist, create it with nonce 1
    await db
      .insert(wallets)
      .values({
        id: walletAddress.toLowerCase(),
        fractionNonce: 1,
      })
      .onConflictDoUpdate({
        target: wallets.id,
        set: {
          fractionNonce: sql`${wallets.fractionNonce} + 1`,
        },
      });

    return 1;
  }

  return result[0].nonce;
}

/**
 * Gets the current nonce for a wallet without incrementing
 *
 * @param walletAddress - The wallet address
 * @returns The current nonce value (0 if wallet doesn't exist)
 */
export async function getCurrentWalletNonce(
  walletAddress: string
): Promise<number> {
  const result = await db
    .select({ nonce: wallets.fractionNonce })
    .from(wallets)
    .where(eq(wallets.id, walletAddress.toLowerCase()))
    .limit(1);

  return result[0]?.nonce ?? 0;
}
