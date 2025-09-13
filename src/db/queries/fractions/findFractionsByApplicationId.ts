import { eq, desc, and, gt, inArray } from "drizzle-orm";
import { db } from "../../db";
import { fractions } from "../../schema";
import { FRACTION_STATUS } from "../../../constants/fractions";

/**
 * Finds all fractions for a given application ID
 *
 * @param applicationId - The application ID
 * @returns Array of fractions for the application
 */
export async function findFractionsByApplicationId(applicationId: string) {
  return await db
    .select()
    .from(fractions)
    .where(eq(fractions.applicationId, applicationId))
    .orderBy(fractions.createdAt);
}

/**
 * Finds a specific fraction by its ID
 *
 * @param fractionId - The fraction ID (bytes32 hex string)
 * @returns The fraction or null if not found
 */
export async function findFractionById(fractionId: string) {
  const result = await db
    .select()
    .from(fractions)
    .where(eq(fractions.id, fractionId))
    .limit(1);

  return result[0] || null;
}

/**
 * Finds the latest fraction for an application
 *
 * @param applicationId - The application ID
 * @returns The latest fraction or null if none exist
 */
export async function findLatestFractionByApplicationId(applicationId: string) {
  const result = await db
    .select()
    .from(fractions)
    .where(eq(fractions.applicationId, applicationId))
    .orderBy(desc(fractions.createdAt))
    .limit(1);

  return result[0] || null;
}

/**
 * Finds the active fraction for an application (draft or committed status, not expired)
 *
 * @param applicationId - The application ID
 * @returns The active fraction or null if none exist
 */
export async function findActiveFractionByApplicationId(applicationId: string) {
  const now = new Date();
  const result = await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        inArray(fractions.status, [
          FRACTION_STATUS.DRAFT,
          FRACTION_STATUS.COMMITTED,
        ]),
        gt(fractions.expirationAt, now)
      )
    )
    .orderBy(desc(fractions.createdAt))
    .limit(1);

  return result[0] || null;
}

/**
 * Checks if an application has any filled fractions
 *
 * @param applicationId - The application ID
 * @returns True if the application has a filled fraction, false otherwise
 */
export async function hasFilledFraction(
  applicationId: string
): Promise<boolean> {
  const result = await db
    .select({ id: fractions.id })
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        eq(fractions.status, FRACTION_STATUS.FILLED)
      )
    )
    .limit(1);

  return result.length > 0;
}
