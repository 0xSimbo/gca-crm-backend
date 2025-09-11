import { keccak256, toUtf8Bytes } from "ethers";
import { db } from "../../db/db";
import { fractions } from "../../db/schema";
import { eq, desc } from "drizzle-orm";

/**
 * Generates a unique fraction ID by combining applicationId and nonce
 * The ID is created by hashing applicationId + nonce to create a bytes32 hex string
 *
 * @param applicationId - The application ID
 * @param nonce - The nonce (must be unique for this application)
 * @returns bytes32 hex string (0x + 64 characters)
 */
export function createFractionId(applicationId: string, nonce: number): string {
  const combined = `${applicationId}:${nonce}`;
  return keccak256(toUtf8Bytes(combined));
}

/**
 * Gets the next available nonce for an application
 *
 * @param applicationId - The application ID
 * @returns The next available nonce (starting from 1)
 */
export async function getNextNonceForApplication(
  applicationId: string
): Promise<number> {
  const lastFraction = await db
    .select({ nonce: fractions.nonce })
    .from(fractions)
    .where(eq(fractions.applicationId, applicationId))
    .orderBy(desc(fractions.nonce))
    .limit(1);

  return lastFraction.length > 0 ? lastFraction[0].nonce + 1 : 1;
}

/**
 * Generates a unique fraction ID for an application by finding the next available nonce
 *
 * @param applicationId - The application ID
 * @returns Object containing the fraction ID and nonce used
 */
export async function generateUniqueFractionId(applicationId: string): Promise<{
  fractionId: string;
  nonce: number;
}> {
  const nonce = await getNextNonceForApplication(applicationId);
  const fractionId = createFractionId(applicationId, nonce);

  return {
    fractionId,
    nonce,
  };
}
