import { and, lt, eq, gt } from "drizzle-orm";
import { db } from "../../db/db";
import { fractions } from "../../db/schema";
import {
  MAX_SPONSOR_SPLIT_PERCENT,
  SPONSOR_SPLIT_INCREMENT,
  FRACTION_STALE_PERIOD_MS,
} from "../../constants/fractions";

/**
 * Increments sponsor split percentage for stale fractions
 *
 * Criteria for incrementing:
 * 1. Fraction is not committed on-chain (isCommittedOnChain = false)
 * 2. Fraction hasn't been updated in the past 7 days
 * 3. Fraction has not expired (expirationAt > now)
 * 4. Current sponsor split is less than 80%
 */
export async function incrementStaleFractions() {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - FRACTION_STALE_PERIOD_MS);

  console.log(
    `[incrementStaleFractions] Starting cron at ${now.toISOString()}`
  );
  console.log(
    `[incrementStaleFractions] Stale threshold: ${staleThreshold.toISOString()}`
  );

  try {
    // Find fractions that meet the criteria for incrementing
    const staleFractions = await db
      .select()
      .from(fractions)
      .where(
        and(
          // Not committed on-chain
          eq(fractions.isCommittedOnChain, false),
          // Haven't been updated in the past 7 days
          lt(fractions.updatedAt, staleThreshold),
          // Not expired yet
          gt(fractions.expirationAt, now),
          // Current sponsor split is less than max (80%)
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
      const newSponsorSplit = Math.min(
        fraction.sponsorSplitPercent + SPONSOR_SPLIT_INCREMENT,
        MAX_SPONSOR_SPLIT_PERCENT
      );

      console.log(
        `[incrementStaleFractions] Updating fraction ${fraction.id}: ${fraction.sponsorSplitPercent}% -> ${newSponsorSplit}%`
      );

      const updated = await db
        .update(fractions)
        .set({
          sponsorSplitPercent: newSponsorSplit,
          updatedAt: now,
        })
        .where(eq(fractions.id, fraction.id))
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
