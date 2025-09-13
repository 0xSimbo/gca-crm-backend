import { and, lt, eq, inArray } from "drizzle-orm";
import { db } from "../../db/db";
import { fractions } from "../../db/schema";
import { FRACTION_STATUS } from "../../constants/fractions";
import { markFractionAsExpired } from "../../db/mutations/fractions/createFraction";

/**
 * Marks expired fractions that are still in draft or committed status
 *
 * Criteria for expiring:
 * 1. Fraction has passed its expiration date
 * 2. Fraction is in draft or committed status (not already filled, cancelled, or expired)
 */
export async function expireFractions() {
  const now = new Date();

  console.log(`[expireFractions] Starting cron at ${now.toISOString()}`);

  try {
    // Find fractions that should be expired
    const expiredFractions = await db
      .select()
      .from(fractions)
      .where(
        and(
          // Has passed expiration date
          lt(fractions.expirationAt, now),
          // Is in a status that can be expired
          inArray(fractions.status, [
            FRACTION_STATUS.DRAFT,
            FRACTION_STATUS.COMMITTED,
          ])
        )
      );

    console.log(
      `[expireFractions] Found ${expiredFractions.length} fractions to expire`
    );

    if (expiredFractions.length === 0) {
      console.log(`[expireFractions] No fractions to expire`);
      return { expired: 0, fractions: [] };
    }

    const updatedFractions = [];

    // Update each fraction
    for (const fraction of expiredFractions) {
      console.log(
        `[expireFractions] Expiring fraction ${fraction.id} (expired at ${fraction.expirationAt})`
      );

      const updated = await markFractionAsExpired(fraction.id);

      if (updated.length > 0) {
        updatedFractions.push(updated[0]);
      }
    }

    console.log(
      `[expireFractions] Successfully expired ${updatedFractions.length} fractions`
    );

    return {
      expired: updatedFractions.length,
      fractions: updatedFractions,
    };
  } catch (error) {
    console.error(`[expireFractions] Error:`, error);
    throw error;
  }
}
