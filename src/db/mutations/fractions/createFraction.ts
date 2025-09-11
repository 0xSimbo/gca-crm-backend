import { db } from "../../db";
import { fractions, FractionInsertType } from "../../schema";
import { eq } from "drizzle-orm";
import { generateUniqueFractionId } from "../../../utils/fractions/generateFractionId";
import { FRACTION_LIFETIME_MS } from "../../../constants/fractions";

export interface CreateFractionParams {
  applicationId: string;
  createdBy: string;
  sponsorSplitPercent: number;
}

/**
 * Creates a new fraction entry in the database
 * Automatically generates a unique fraction ID using applicationId + nonce
 *
 * @param params - The parameters for creating the fraction
 * @returns The created fraction with the generated ID
 */
export async function createFraction(params: CreateFractionParams) {
  const { fractionId, nonce } = await generateUniqueFractionId(
    params.applicationId
  );

  const now = new Date();
  const expirationAt = new Date(now.getTime() + FRACTION_LIFETIME_MS);

  const fractionData: FractionInsertType = {
    id: fractionId,
    applicationId: params.applicationId,
    nonce,
    createdBy: params.createdBy,
    sponsorSplitPercent: params.sponsorSplitPercent,
    createdAt: now,
    updatedAt: now,
    isCommittedOnChain: false,
    txHash: null,
    committedAt: null,
    expirationAt,
  };

  const result = await db.insert(fractions).values(fractionData).returning();

  return result[0];
}

/**
 * Updates a fraction when it's committed on-chain
 *
 * @param fractionId - The fraction ID
 * @param txHash - The transaction hash
 */
export async function markFractionAsCommitted(
  fractionId: string,
  txHash: string
) {
  return await db
    .update(fractions)
    .set({
      isCommittedOnChain: true,
      txHash,
      committedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(fractions.id, fractionId))
    .returning();
}
