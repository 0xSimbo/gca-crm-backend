import { FRACTION_STATUS } from "../../../constants/fractions";
import { db } from "../../db";
import { fractionSplits, fractions } from "../../schema";
import { eq, desc, and, not } from "drizzle-orm";

/**
 * Calculate the number of steps purchased from step price and amount
 * @param stepPrice - Price per step (18 decimals)
 * @param amount - Total amount paid (18 decimals)
 * @returns Number of steps purchased (always an integer)
 */
export function calculateStepsPurchased(
  stepPrice: string,
  amount: string
): number {
  try {
    const stepPriceBigInt = BigInt(stepPrice);
    const amountBigInt = BigInt(amount);

    if (stepPriceBigInt === 0n) {
      return 0;
    }

    // Calculate steps: amount / stepPrice
    // Using BigInt division which automatically floors the result
    const stepsPurchased = amountBigInt / stepPriceBigInt;

    // Convert to number - BigInt division already gives us a whole number
    const result = Number(stepsPurchased);

    // Safety check: ensure we return an integer
    return Math.floor(result);
  } catch (error) {
    console.error("Error calculating steps purchased:", error, {
      stepPrice,
      amount,
    });
    return 0;
  }
}

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

/**
 * Find splits by wallet address and fraction ID
 *
 * @param walletAddress - The wallet address (buyer)
 * @param fractionId - The fraction ID
 * @returns Array of fraction splits for the specific wallet and fraction
 */
export async function findSplitsByWalletAndFraction(
  walletAddress: string,
  fractionId: string
) {
  return await db
    .select()
    .from(fractionSplits)
    .where(
      and(
        eq(fractionSplits.buyer, walletAddress),
        eq(fractionSplits.fractionId, fractionId)
      )
    )
    .orderBy(desc(fractionSplits.createdAt));
}

/**
 * Find recent fraction splits activity with fraction details
 *
 * @param limit - Number of recent splits to return (default: 50)
 * @returns Array of recent fraction splits with fraction information
 */
export async function findRecentSplitsActivity(limit: number = 50) {
  return await db
    .select({
      split: fractionSplits,
      fraction: {
        id: fractions.id,
        applicationId: fractions.applicationId,
        status: fractions.status,
        sponsorSplitPercent: fractions.sponsorSplitPercent,
        totalSteps: fractions.totalSteps,
        splitsSold: fractions.splitsSold,
        isFilled: fractions.isFilled,
        rewardScore: fractions.rewardScore,
      },
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .orderBy(desc(fractionSplits.createdAt))
    .limit(limit);
}
