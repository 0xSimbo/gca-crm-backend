import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { fractions, fractionSplits } from "../../schema";
import { FRACTION_STATUS } from "../../../constants/fractions";

/**
 * Find all refundable fractions for a specific wallet address
 * A fraction is refundable if:
 * - The user has purchased splits
 * - The fraction is either expired or cancelled
 * - The fraction is not filled
 *
 * @param walletAddress - The wallet address of the buyer
 * @returns Array of refundable fractions with split details
 */
export async function findRefundableFractionsByWallet(walletAddress: string) {
  // First, get all unique fractionIds where the wallet has purchased splits
  const userSplits = await db
    .select({
      fractionId: fractionSplits.fractionId,
      totalStepsPurchased: sql<number>`CAST(SUM(${fractionSplits.stepsPurchased}) AS INTEGER)`,
      totalAmountSpent: sql<string>`SUM(CAST(${fractionSplits.amount} AS NUMERIC))::TEXT`,
      purchaseCount: sql<number>`COUNT(*)::INTEGER`,
    })
    .from(fractionSplits)
    .where(eq(fractionSplits.buyer, walletAddress.toLowerCase()))
    .groupBy(fractionSplits.fractionId);

  if (userSplits.length === 0) {
    return [];
  }

  const fractionIds = userSplits.map((split) => split.fractionId);

  // Get fraction details for these fractions, filtering for refundable ones
  const refundableFractions = await db
    .select()
    .from(fractions)
    .where(
      and(
        inArray(fractions.id, fractionIds),
        inArray(fractions.status, [
          FRACTION_STATUS.EXPIRED,
          FRACTION_STATUS.CANCELLED,
        ]),
        eq(fractions.isFilled, false)
      )
    );

  // Combine the data
  const result = refundableFractions.map((fraction) => {
    const userSplitData = userSplits.find(
      (split) => split.fractionId === fraction.id
    );

    return {
      fraction: {
        id: fraction.id,
        applicationId: fraction.applicationId,
        status: fraction.status,
        createdBy: fraction.createdBy,
        owner: fraction.owner,
        token: fraction.token,
        step: fraction.step,
        totalSteps: fraction.totalSteps,
        splitsSold: fraction.splitsSold,
        expirationAt: fraction.expirationAt,
        isCommittedOnChain: fraction.isCommittedOnChain,
        txHash: fraction.txHash,
      },
      userPurchaseData: {
        walletAddress,
        totalStepsPurchased: userSplitData?.totalStepsPurchased || 0,
        totalAmountSpent: userSplitData?.totalAmountSpent || "0",
        purchaseCount: userSplitData?.purchaseCount || 0,
      },
      refundDetails: {
        // For claimRefund function, we need:
        user: walletAddress,
        creator: fraction.createdBy,
        fractionId: fraction.id,
        // The refund amount would be calculated as: totalStepsPurchased * step
        estimatedRefundAmount: fraction.step
          ? (
              BigInt(userSplitData?.totalStepsPurchased || 0) *
              BigInt(fraction.step)
            ).toString()
          : "0",
      },
    };
  });

  return result;
}

/**
 * Get detailed split transactions for refundable fractions
 * This provides transaction-level detail for a specific fraction and wallet
 *
 * @param walletAddress - The wallet address of the buyer
 * @param fractionId - The fraction ID
 * @returns Array of individual split transactions
 */
export async function getRefundableSplitDetails(
  walletAddress: string,
  fractionId: string
) {
  const fraction = await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.id, fractionId),
        inArray(fractions.status, [
          FRACTION_STATUS.EXPIRED,
          FRACTION_STATUS.CANCELLED,
        ]),
        eq(fractions.isFilled, false)
      )
    )
    .limit(1);

  if (fraction.length === 0) {
    return null;
  }

  const splits = await db
    .select()
    .from(fractionSplits)
    .where(
      and(
        eq(fractionSplits.fractionId, fractionId),
        eq(fractionSplits.buyer, walletAddress.toLowerCase())
      )
    )
    .orderBy(fractionSplits.createdAt);

  return {
    fraction: fraction[0],
    splits,
  };
}
