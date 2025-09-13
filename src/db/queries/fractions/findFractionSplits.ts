import { db } from "../../db";
import { fractionSplits, fractions } from "../../schema";
import { eq, desc, and } from "drizzle-orm";

/**
 * Find all splits for a specific fraction
 *
 * @param fractionId - The fraction ID
 * @returns Array of fraction splits
 */
export async function findFractionSplits(fractionId: string) {
  return await db
    .select()
    .from(fractionSplits)
    .where(eq(fractionSplits.fractionId, fractionId))
    .orderBy(desc(fractionSplits.createdAt));
}

/**
 * Find a specific fraction split by transaction hash and log index
 *
 * @param transactionHash - The transaction hash
 * @param logIndex - The log index
 * @returns The fraction split if found
 */
export async function findFractionSplitByTxHash(
  transactionHash: string,
  logIndex: number
) {
  const result = await db
    .select()
    .from(fractionSplits)
    .where(
      and(
        eq(fractionSplits.transactionHash, transactionHash),
        eq(fractionSplits.logIndex, logIndex)
      )
    )
    .limit(1);

  return result[0] || null;
}

/**
 * Find splits by buyer address
 *
 * @param buyerAddress - The buyer address
 * @param limit - Optional limit (default: 50)
 * @returns Array of fraction splits
 */
export async function findSplitsByBuyer(
  buyerAddress: string,
  limit: number = 50
) {
  return await db
    .select({
      split: fractionSplits,
      fraction: fractions,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(eq(fractionSplits.buyer, buyerAddress))
    .orderBy(desc(fractionSplits.createdAt))
    .limit(limit);
}

/**
 * Find splits by creator address
 *
 * @param creatorAddress - The creator address
 * @param limit - Optional limit (default: 50)
 * @returns Array of fraction splits
 */
export async function findSplitsByCreator(
  creatorAddress: string,
  limit: number = 50
) {
  return await db
    .select({
      split: fractionSplits,
      fraction: fractions,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .where(eq(fractionSplits.creator, creatorAddress))
    .orderBy(desc(fractionSplits.createdAt))
    .limit(limit);
}
