import { eq, desc, and, gt, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { fractions, ApplicationPriceQuotes } from "../../schema";
import {
  FRACTION_STATUS,
  SGCTL_TOKEN_ADDRESS,
} from "../../../constants/fractions";
import { forwarderAddresses } from "../../../constants/addresses";
import { DECIMALS_BY_TOKEN } from "@glowlabs-org/utils/browser";

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
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        inArray(fractions.status, [
          FRACTION_STATUS.DRAFT,
          FRACTION_STATUS.COMMITTED,
        ]),
        ne(fractions.type, "mining-center")
      )
    )
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
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        inArray(fractions.status, [
          FRACTION_STATUS.DRAFT,
          FRACTION_STATUS.COMMITTED,
        ]),
        ne(fractions.type, "mining-center")
      )
    )
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
        gt(fractions.expirationAt, now),
        ne(fractions.type, "mining-center")
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
export async function hasFilledFraction(applicationId: string): Promise<{
  id: string;
  type: string;
} | null> {
  const res = await db
    .select({ id: fractions.id, type: fractions.type })
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        eq(fractions.status, FRACTION_STATUS.FILLED)
      )
    )
    .limit(1);

  const fraction = res[0] || null;
  return fraction;
}

/**
 * Finds the filled fraction for an application
 *
 * @param applicationId - The application ID
 * @returns The filled fraction or null if none exist
 */
export async function findFilledFractionByApplicationId(applicationId: string) {
  const result = await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        eq(fractions.status, FRACTION_STATUS.FILLED),
        ne(fractions.type, "mining-center")
      )
    )
    .orderBy(desc(fractions.createdAt))
    .limit(1);

  return result[0] || null;
}

/**
 * Finds all mining-center fractions for a given user
 *
 * @param userId - The user ID
 * @returns Array of mining-center fractions for the user
 */
export async function findMiningCenterFractionsByUserId(userId: string) {
  return await db
    .select()
    .from(fractions)
    .where(
      and(eq(fractions.createdBy, userId), eq(fractions.type, "mining-center"))
    )
    .orderBy(desc(fractions.createdAt));
}

/**
 * Finds active (draft or committed) fractions for a given user
 *
 * @param userId - The user ID (wallet address)
 * @returns Array of active fractions for the user
 */
export async function findActiveFractionsByUserId(userId: string) {
  const now = new Date();
  return await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.createdBy, userId.toLowerCase()),
        inArray(fractions.status, [
          FRACTION_STATUS.DRAFT,
          FRACTION_STATUS.COMMITTED,
        ]),
        gt(fractions.expirationAt, now),
        ne(fractions.type, "mining-center")
      )
    )
    .orderBy(desc(fractions.createdAt));
}

/**
 * Checks if a user has any active (draft or committed) fractions
 * By default, excludes mining-center fractions since they have different validation rules
 *
 * @param userId - The user ID (wallet address)
 * @param includeType - Include only fractions of this type (optional)
 * @returns True if the user has active fractions, false otherwise
 */
export async function hasActiveFractions(userId: string): Promise<boolean> {
  const now = new Date();
  const conditions = [
    eq(fractions.createdBy, userId.toLowerCase()),
    inArray(fractions.status, [
      FRACTION_STATUS.DRAFT,
      FRACTION_STATUS.COMMITTED,
    ]),
    gt(fractions.expirationAt, now),
  ];

  const result = await db
    .select({ id: fractions.id })
    .from(fractions)
    .where(and(...conditions))
    .limit(1);

  return result.length > 0;
}

/**
 * Get all fractions for an application regardless of status
 * Excludes mining-center fractions as they're not part of protocol deposit
 *
 * @param applicationId - The application ID
 * @returns Array of all fractions for the application
 */
export async function getAllFractionsForApplication(applicationId: string) {
  return await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        ne(fractions.type, "mining-center")
      )
    )
    .orderBy(fractions.createdAt);
}

/**
 * Calculate total amount raised for an application across all fractions
 * Converts token amounts to USD using ApplicationPriceQuotes
 * Returns amount in USD (6 decimals)
 *
 * @param applicationId - The application ID
 * @returns Object with total raised in USD (6 decimals) and whether multiple fraction types were used
 */
export async function getTotalRaisedForApplication(
  applicationId: string
): Promise<{
  totalRaisedUSD: bigint;
  hasMultipleFractionTypes: boolean;
  fractionTypes: Set<string>;
}> {
  const allFractions = await db
    .select()
    .from(fractions)
    .where(
      and(
        eq(fractions.applicationId, applicationId),
        ne(fractions.type, "mining-center"), //exclude mining-center fractions cause it's not part of the protocol deposit
        inArray(fractions.status, [
          FRACTION_STATUS.FILLED,
          FRACTION_STATUS.COMMITTED,
          FRACTION_STATUS.EXPIRED,
        ])
      )
    );

  // Get price quotes for USD conversion
  const priceQuotes = await db
    .select()
    .from(ApplicationPriceQuotes)
    .where(eq(ApplicationPriceQuotes.applicationId, applicationId))
    .orderBy(desc(ApplicationPriceQuotes.createdAt))
    .limit(1);

  const prices = priceQuotes[0]?.prices || {};

  let totalRaisedUSD = BigInt(0);
  const fractionTypes = new Set<string>();

  // Helper to get token ticker from address
  const getTokenTicker = (tokenAddress: string | null): string | null => {
    if (!tokenAddress) return null;
    const lowerToken = tokenAddress.toLowerCase();
    if (lowerToken === forwarderAddresses.GLW.toLowerCase()) return "GLW";
    if (lowerToken === forwarderAddresses.USDC.toLowerCase()) return "USDC";
    if (lowerToken === SGCTL_TOKEN_ADDRESS.toLowerCase()) return "GCTL";
    return null;
  };

  // Helper to get token decimals
  const getTokenDecimals = (tokenAddress: string | null): number => {
    if (!tokenAddress) return 6;
    const tokenTicker = getTokenTicker(tokenAddress);
    return (
      DECIMALS_BY_TOKEN[tokenTicker as keyof typeof DECIMALS_BY_TOKEN] || 6
    );
  };

  for (const fraction of allFractions) {
    const stepPrice = fraction.stepPrice
      ? BigInt(fraction.stepPrice)
      : BigInt(0);
    const soldSteps = BigInt(fraction.splitsSold ?? 0);

    // Determine if this fraction should be counted based on type and status
    let shouldCount = false;
    if (fraction.type === "launchpad") {
      // Launchpad (GLW): Only count if FILLED (all-or-nothing)
      shouldCount = fraction.status === FRACTION_STATUS.FILLED;
    } else if (fraction.type === "launchpad-presale") {
      // Launchpad-presale (SGCTL): Count any partial fills (soldSteps > 0)
      shouldCount = soldSteps > BigInt(0);
    }

    if (shouldCount) {
      if (fraction.type) {
        fractionTypes.add(fraction.type);
      }
      const tokenTicker = getTokenTicker(fraction.token);
      const tokenDecimals = getTokenDecimals(fraction.token);

      // Total amount in token's native decimals
      const totalInTokenDecimals = stepPrice * soldSteps;

      // Get price per token in USD (6 decimals)
      // Default prices if not in quotes
      let pricePerToken = BigInt(0);
      if (tokenTicker && prices[tokenTicker]) {
        pricePerToken = BigInt(prices[tokenTicker]);
      } else {
        // Default prices for known tokens
        if (tokenTicker === "USDC" || tokenTicker === "USDG") {
          pricePerToken = BigInt(1000000); // $1.00 in 6 decimals
        }
        console.error(
          `[getTotalRaisedForApplication] No price quote found for token: ${tokenTicker}`
        );
      }

      if (pricePerToken > BigInt(0)) {
        // Calculate USD value
        // Formula: (totalInTokenDecimals * pricePerToken) / (10^tokenDecimals)
        // Result is in 6 decimals USD
        const divisor = BigInt(10) ** BigInt(tokenDecimals);
        const usdValue = (totalInTokenDecimals * pricePerToken) / divisor;
        totalRaisedUSD += usdValue;
      } else
        console.error(
          `[getTotalRaisedForApplication] No price quote found for token: ${tokenTicker}`
        );
    }
  }

  return {
    totalRaisedUSD,
    hasMultipleFractionTypes: fractionTypes.size > 1,
    fractionTypes,
  };
}
