/**
 * Constants for fraction management
 */

// Sponsor split percentage limits
export const MIN_SPONSOR_SPLIT_PERCENT = 20;
export const MAX_SPONSOR_SPLIT_PERCENT = 80;
export const SPONSOR_SPLIT_INCREMENT = 10;

// Valid sponsor split percentages
export const VALID_SPONSOR_SPLIT_PERCENTAGES = [20, 30, 40, 50, 60, 70, 80];

// Time periods (in milliseconds)
export const FRACTION_LIFETIME_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks
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
