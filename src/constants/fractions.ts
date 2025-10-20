/**
 * Constants for fraction management
 */

// Sponsor split percentage limits
export const MIN_SPONSOR_SPLIT_PERCENT = 5;
export const MAX_SPONSOR_SPLIT_PERCENT = 95;

// Valid sponsor split percentages - any integer from 5% to 95%
export const VALID_SPONSOR_SPLIT_PERCENTAGES = Array.from(
  { length: MAX_SPONSOR_SPLIT_PERCENT - MIN_SPONSOR_SPLIT_PERCENT + 1 },
  (_, i) => MIN_SPONSOR_SPLIT_PERCENT + i
);

/**
 * Calculate the next 10% increment from the current sponsor split percent
 * Examples: 5% -> 10%, 23% -> 30%, 30% -> 40%, 87% -> 90%, 90% -> 95%, 95% -> 95%
 */
export function getNextSponsorSplitIncrement(currentPercent: number): number {
  if (currentPercent >= MAX_SPONSOR_SPLIT_PERCENT) {
    return MAX_SPONSOR_SPLIT_PERCENT;
  }
  // Round up to the next multiple of 10
  return Math.min(
    Math.ceil(currentPercent / 10) * 10,
    MAX_SPONSOR_SPLIT_PERCENT
  );
}

// Time periods (in milliseconds)
export const LAUNCHPAD_FRACTION_LIFETIME_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks
export const MINING_CENTER_FRACTION_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000; // 6 days
export const FRACTION_STALE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Time periods (in days for easier reading)
export const FRACTION_LIFETIME_DAYS = 28; // 4 weeks
export const FRACTION_STALE_PERIOD_DAYS = 7; // 7 days

// Fraction status constants
export const FRACTION_STATUS = {
  DRAFT: "draft",
  COMMITTED: "committed",
  CANCELLED: "cancelled",
  FILLED: "filled",
  EXPIRED: "expired",
} as const;

export type FractionStatus =
  (typeof FRACTION_STATUS)[keyof typeof FRACTION_STATUS];
