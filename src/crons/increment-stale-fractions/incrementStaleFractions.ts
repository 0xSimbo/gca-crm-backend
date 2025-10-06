import { and, lt, eq, gt, not } from "drizzle-orm";
import { db } from "../../db/db";
import { fractions } from "../../db/schema";
import {
  MAX_SPONSOR_SPLIT_PERCENT,
  FRACTION_STALE_PERIOD_MS,
  FRACTION_STATUS,
  getNextSponsorSplitIncrement,
} from "../../constants/fractions";

/**
 * Increments sponsor split percentage for stale fractions
 *
 * Criteria for incrementing:
 * 1. Fraction is not committed on-chain (isCommittedOnChain = false)
 * 2. Fraction hasn't been updated in the past 7 days
 * 3. Fraction has not expired (expirationAt > now)
 * 4. Current sponsor split is less than 90%
 *
 * Increment logic: Rounds up to the next 10% increment
 * Examples: 5% -> 10%, 23% -> 30%, 87% -> 90%
 */
export async function incrementStaleFractions() {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - FRACTION_STALE_PERIOD_MS);

  try {
    // Find fractions that meet the criteria for incrementing
    const staleFractions = await db
      .select()
      .from(fractions)
      .where(
        and(
          // Haven't been updated in the past 7 days
          lt(fractions.updatedAt, staleThreshold),
          // Not cancelled
          not(eq(fractions.status, FRACTION_STATUS.CANCELLED)),
          // CRITICAL: Not filled (filled fractions cannot be modified)
          eq(fractions.isFilled, false),
          not(eq(fractions.status, FRACTION_STATUS.FILLED)),
          // Not expired yet
          gt(fractions.expirationAt, now),
          // Current sponsor split is less than max (90%)
          lt(fractions.sponsorSplitPercent, MAX_SPONSOR_SPLIT_PERCENT)
        )
      );

    console.log(
      `[incrementStaleFractions] Found ${staleFractions.length} stale fractions to increment`
    );

    if (staleFractions.length === 0) {
      console.log(`[incrementStaleFractions] No stale fractions found`);
      return { updated: 0, fractions: [] };
    }

    const updatedFractions = [];

    // Update each fraction
    for (const fraction of staleFractions) {
      // Double-check that fraction is not filled before updating
      if (fraction.isFilled || fraction.status === FRACTION_STATUS.FILLED) {
        console.warn(
          `[incrementStaleFractions] Skipping filled fraction ${fraction.id}`
        );
        continue;
      }

      const newSponsorSplit = getNextSponsorSplitIncrement(
        fraction.sponsorSplitPercent
      );

      console.log(
        `[incrementStaleFractions] Updating fraction ${fraction.id}: ${fraction.sponsorSplitPercent}% -> ${newSponsorSplit}%`
      );

      // Add WHERE clause to ensure we only update non-filled fractions
      const updated = await db
        .update(fractions)
        .set({
          sponsorSplitPercent: newSponsorSplit,
          updatedAt: now,
        })
        .where(
          and(
            eq(fractions.id, fraction.id),
            eq(fractions.isFilled, false),
            not(eq(fractions.status, FRACTION_STATUS.FILLED))
          )
        )
        .returning();

      if (updated.length > 0) {
        updatedFractions.push(updated[0]);
      }
    }

    console.log(
      `[incrementStaleFractions] Successfully updated ${updatedFractions.length} fractions`
    );

    return {
      updated: updatedFractions.length,
      fractions: updatedFractions,
    };
  } catch (error) {
    console.error(`[incrementStaleFractions] Error:`, error);
    throw error;
  }
}
