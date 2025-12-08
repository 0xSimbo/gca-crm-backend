/**
 * Constants for fraction management
 */

import { SGCTL_OFFCHAIN_TOKEN_ADDRESS } from "@glowlabs-org/utils/browser";

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

// SGCTL token identifier (recognizable fake address for off-chain fractions)
export const SGCTL_TOKEN_ADDRESS = SGCTL_OFFCHAIN_TOKEN_ADDRESS;

/**
 * Calculate the next Tuesday at 12:00 PM EST
 * Used for launchpad-presale (SGCTL) fraction expiration
 */
export function getNextTuesdayNoonEST(): Date {
  const now = new Date();

  // Get current time formatted in ET timezone
  const etString = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Parse the ET string to get current ET date/time components
  const [datePart, timePart] = etString.split(", ");
  const [month, day, year] = datePart.split("/").map(Number);
  const [hour] = timePart.split(":").map(Number);

  // Create a date object for "now" in ET
  const currentET = new Date(year, month - 1, day, hour);
  const currentDayOfWeek = currentET.getDay(); // 0 = Sunday, 2 = Tuesday

  // Calculate days to add to get to next Tuesday
  let daysToAdd: number;
  if (currentDayOfWeek === 2) {
    // It's Tuesday
    if (hour < 12) {
      // Before 12 PM, use today
      daysToAdd = 0;
    } else {
      // After 12 PM, use next Tuesday
      daysToAdd = 7;
    }
  } else if (currentDayOfWeek < 2) {
    // Sunday (0) or Monday (1) - calculate days until Tuesday
    daysToAdd = 2 - currentDayOfWeek;
  } else {
    // Wednesday (3) through Saturday (6) - calculate days until next Tuesday
    daysToAdd = 9 - currentDayOfWeek;
  }

  // Calculate the target Tuesday
  const targetTuesday = new Date(year, month - 1, day + daysToAdd, 12, 0, 0, 0);

  // Format target date as a string to convert back considering ET timezone
  const targetYear = targetTuesday.getFullYear();
  const targetMonth = String(targetTuesday.getMonth() + 1).padStart(2, "0");
  const targetDay = String(targetTuesday.getDate()).padStart(2, "0");

  // Create a date string for Tuesday at 12 PM in ET timezone format
  // We need to find what UTC time corresponds to 12 PM ET on that day
  const targetDateString = `${targetYear}-${targetMonth}-${targetDay}T12:00:00`;

  // Create a temporary date and format it in ET to calculate the offset
  const tempDate = new Date(targetDateString);
  const tempET = new Date(
    tempDate.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  // Calculate the difference between UTC and ET for that specific date
  const offset = tempDate.getTime() - tempET.getTime();

  // Apply the offset to get the correct UTC time for 12 PM ET on that Tuesday
  const utcDate = new Date(new Date(targetDateString).getTime() - offset);

  return utcDate;
}
