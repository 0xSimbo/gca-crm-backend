import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { fractionRefunds, FractionRefundInsertType } from "../../schema";
import { findFractionById } from "../../queries/fractions/findFractionsByApplicationId";

export interface RecordFractionRefundParams {
  fractionId: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: number;
  creator: string;
  user: string;
  refundTo: string;
  amount: string; // Keep as string in params, convert to numeric when storing
  timestamp: number;
}

/**
 * Records a fraction refund event in the database
 *
 * @param params - The parameters for recording the refund
 * @returns The created refund record
 * @throws Error if the fraction doesn't exist or refund already recorded
 */
export async function recordFractionRefund(params: RecordFractionRefundParams) {
  // First verify the fraction exists
  const fraction = await findFractionById(params.fractionId);
  if (!fraction) {
    throw new Error(`Fraction not found: ${params.fractionId}`);
  }

  // Verify the creator matches
  if (fraction.createdBy.toLowerCase() !== params.creator.toLowerCase()) {
    throw new Error(
      `Creator mismatch: expected ${fraction.createdBy}, got ${params.creator}`
    );
  }

  // Check if refund already exists for this user and fraction
  const existingRefund = await db
    .select()
    .from(fractionRefunds)
    .where(
      and(
        eq(fractionRefunds.fractionId, params.fractionId),
        eq(fractionRefunds.user, params.user.toLowerCase())
      )
    )
    .limit(1);

  if (existingRefund.length > 0) {
    throw new Error(
      `Refund already recorded for user ${params.user} on fraction ${params.fractionId}`
    );
  }

  // Insert the refund record
  const refundData: FractionRefundInsertType = {
    fractionId: params.fractionId,
    transactionHash: params.transactionHash,
    blockNumber: params.blockNumber,
    logIndex: params.logIndex,
    creator: params.creator.toLowerCase(),
    user: params.user.toLowerCase(),
    refundTo: params.refundTo.toLowerCase(),
    amount: params.amount,
    timestamp: params.timestamp,
    createdAt: new Date(),
  };

  const [createdRefund] = await db
    .insert(fractionRefunds)
    .values(refundData)
    .returning();

  return createdRefund;
}

/**
 * Finds a fraction refund by transaction hash and log index
 *
 * @param transactionHash - The transaction hash
 * @param logIndex - The log index
 * @returns The fraction refund if found
 */
export async function findFractionRefundByTxHash(
  transactionHash: string,
  logIndex: number
) {
  const result = await db
    .select()
    .from(fractionRefunds)
    .where(
      and(
        eq(fractionRefunds.transactionHash, transactionHash),
        eq(fractionRefunds.logIndex, logIndex)
      )
    )
    .limit(1);

  return result[0] || null;
}

/**
 * Check if a user has already been refunded for a fraction
 *
 * @param fractionId - The fraction ID
 * @param userAddress - The user's wallet address
 * @returns True if refunded, false otherwise
 */
export async function hasUserBeenRefunded(
  fractionId: string,
  userAddress: string
): Promise<boolean> {
  const result = await db
    .select({ id: fractionRefunds.id })
    .from(fractionRefunds)
    .where(
      and(
        eq(fractionRefunds.fractionId, fractionId),
        eq(fractionRefunds.user, userAddress.toLowerCase())
      )
    )
    .limit(1);

  return result.length > 0;
}
