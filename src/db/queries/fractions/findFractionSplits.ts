import { db } from "../../db";
import { fractionSplits, fractions } from "../../schema";
import { eq, desc, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

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
export interface RecentSplitRow {
  split: {
    fractionId: string;
    transactionHash: string;
    blockNumber: string;
    buyer: string;
    creator: string;
    stepsPurchased: number;
    amount: string;
    step: string;
    timestamp: number;
    rewardScore: number | null;
    createdAt: Date;
  };
  fraction: {
    id: string;
    applicationId: string;
    status: string;
    totalSteps: number | null;
    splitsSold: number | null;
    isFilled: boolean;
    rewardScore: number | null;
    token: string | null;
    type: string;
  };
}

export async function findRecentSplitsActivity(
  limit: number = 50,
  options?: {
    fractionType?: "launchpad" | "mining-center";
    buyerAddress?: string;
  }
): Promise<RecentSplitRow[]> {
  // If filtering by type, push the filter into the join and apply the limit on the final result
  if (options?.fractionType) {
    return await db
      .select({
        split: {
          fractionId: fractionSplits.fractionId,
          transactionHash: fractionSplits.transactionHash,
          blockNumber: fractionSplits.blockNumber,
          buyer: fractionSplits.buyer,
          creator: fractionSplits.creator,
          stepsPurchased: fractionSplits.stepsPurchased,
          amount: fractionSplits.amount,
          step: fractionSplits.step,
          timestamp: fractionSplits.timestamp,
          rewardScore: fractionSplits.rewardScore,
          createdAt: fractionSplits.createdAt,
        },
        fraction: {
          id: fractions.id,
          applicationId: fractions.applicationId,
          status: fractions.status,
          totalSteps: fractions.totalSteps,
          splitsSold: fractions.splitsSold,
          isFilled: fractions.isFilled,
          rewardScore: fractions.rewardScore,
          token: fractions.token,
          type: fractions.type,
        },
      })
      .from(fractionSplits)
      .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
      .where(
        and(
          eq(fractions.type, options.fractionType),
          options.buyerAddress
            ? eq(fractionSplits.buyer, options.buyerAddress.toLowerCase())
            : sql`true`
        )
      )
      .orderBy(desc(fractionSplits.createdAt))
      .limit(limit);
  }

  // Fast path: grab the top N recent splits first (optionally filtered by buyer), then join to fractions
  const recentSplitsSubquery = db
    .select({
      fractionId: fractionSplits.fractionId,
      transactionHash: fractionSplits.transactionHash,
      blockNumber: fractionSplits.blockNumber,
      buyer: fractionSplits.buyer,
      creator: fractionSplits.creator,
      stepsPurchased: fractionSplits.stepsPurchased,
      amount: fractionSplits.amount,
      step: fractionSplits.step,
      timestamp: fractionSplits.timestamp,
      rewardScore: fractionSplits.rewardScore,
      createdAt: fractionSplits.createdAt,
    })
    .from(fractionSplits)
    .where(
      options?.buyerAddress
        ? eq(fractionSplits.buyer, options.buyerAddress.toLowerCase())
        : sql`true`
    )
    .orderBy(desc(fractionSplits.createdAt))
    .limit(limit)
    .as("recent_splits");

  return await db
    .select({
      split: {
        fractionId: recentSplitsSubquery.fractionId,
        transactionHash: recentSplitsSubquery.transactionHash,
        blockNumber: recentSplitsSubquery.blockNumber,
        buyer: recentSplitsSubquery.buyer,
        creator: recentSplitsSubquery.creator,
        stepsPurchased: recentSplitsSubquery.stepsPurchased,
        amount: recentSplitsSubquery.amount,
        step: recentSplitsSubquery.step,
        timestamp: recentSplitsSubquery.timestamp,
        rewardScore: recentSplitsSubquery.rewardScore,
        createdAt: recentSplitsSubquery.createdAt,
      },
      fraction: {
        id: fractions.id,
        applicationId: fractions.applicationId,
        status: fractions.status,
        totalSteps: fractions.totalSteps,
        splitsSold: fractions.splitsSold,
        isFilled: fractions.isFilled,
        rewardScore: fractions.rewardScore,
        token: fractions.token,
        type: fractions.type,
      },
    })
    .from(recentSplitsSubquery)
    .innerJoin(fractions, eq(recentSplitsSubquery.fractionId, fractions.id))
    .orderBy(desc(recentSplitsSubquery.createdAt));
}
