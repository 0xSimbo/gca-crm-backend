import { db } from "../../db";
import {
  fractions,
  FractionInsertType,
  fractionSplits,
  FractionSplitInsertType,
} from "../../schema";
import { eq, sql, and, not } from "drizzle-orm";
import { generateUniqueFractionId } from "../../../utils/fractions/generateFractionId";
import {
  LAUNCHPAD_FRACTION_LIFETIME_MS,
  FRACTION_STATUS,
  VALID_SPONSOR_SPLIT_PERCENTAGES,
  MINING_CENTER_FRACTION_LIFETIME_MS,
  SGCTL_TOKEN_ADDRESS,
  getNextTuesdayNoonEST,
} from "../../../constants/fractions";
import {
  hasFilledFraction,
  hasActiveFractions,
  getTotalRaisedForApplication,
} from "../../queries/fractions/findFractionsByApplicationId";
import { FindFirstApplicationById } from "../../queries/applications/findFirstApplicationById";
import { getFractionEventService } from "../../../services/eventListener";
import { completeApplicationAndCreateFarm } from "../../../routers/applications-router/publicRoutes";
import { createSlackClient } from "../../../slack/create-slack-client";
import { forwarderAddresses } from "../../../constants/addresses";

const SLACK_CHANNEL = "#devs";

/**
 * Calculates the next Saturday at 2:00 PM ET
 * @returns Date object set to the following Saturday at 2:00 PM Eastern Time (stored as UTC)
 */
function getNextSaturdayAt2PMET(): Date {
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
  const currentDayOfWeek = currentET.getDay(); // 0 = Sunday, 6 = Saturday

  // Calculate days to add to get to next Saturday
  let daysToAdd: number;
  if (currentDayOfWeek === 6) {
    // It's Saturday
    if (hour < 14) {
      // Before 2 PM, use today
      daysToAdd = 0;
    } else {
      // After 2 PM, use next Saturday
      daysToAdd = 7;
    }
  } else {
    // Calculate days until next Saturday
    daysToAdd = (6 - currentDayOfWeek + 7) % 7;
    if (daysToAdd === 0) daysToAdd = 7; // If somehow 0, go to next week
  }

  // Calculate the target Saturday
  const targetSaturday = new Date(
    year,
    month - 1,
    day + daysToAdd,
    14,
    0,
    0,
    0
  );

  // Format target date as a string to convert back considering ET timezone
  const targetYear = targetSaturday.getFullYear();
  const targetMonth = String(targetSaturday.getMonth() + 1).padStart(2, "0");
  const targetDay = String(targetSaturday.getDate()).padStart(2, "0");

  // Create a date string for Saturday at 2 PM in ET timezone format
  // We need to find what UTC time corresponds to 2 PM ET on that day
  const targetDateString = `${targetYear}-${targetMonth}-${targetDay}T14:00:00`;

  // Create a temporary date and format it in ET to calculate the offset
  const tempDate = new Date(targetDateString);
  const tempET = new Date(
    tempDate.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  // Calculate the difference between UTC and ET for that specific date
  const offset = tempDate.getTime() - tempET.getTime();

  // Apply the offset to get the correct UTC time for 2 PM ET on that Saturday
  const utcDate = new Date(new Date(targetDateString).getTime() - offset);

  return utcDate;
}

export interface CreateFractionParams {
  applicationId: string;
  createdBy: string;
  sponsorSplitPercent: number;
  stepPrice: string; // Price per step in token decimals
  totalSteps: number; // Total number of steps
  rewardScore?: number; // Reward score for launchpad fractions (optional, only used for launchpad type, e.g., 50, 100, 200)
  type?: "launchpad" | "mining-center" | "launchpad-presale";
}

/**
 * Validates that a fraction can be modified (not filled)
 *
 * @param fraction - The fraction to validate
 * @throws Error if the fraction is filled and cannot be modified
 */
export function validateFractionCanBeModified(fraction: any) {
  if (fraction.isFilled || fraction.status === FRACTION_STATUS.FILLED) {
    throw new Error(
      `Cannot modify fraction ${fraction.id}: fraction is filled and immutable`
    );
  }
}

/**
 * Creates a safe WHERE clause that ensures we never update filled fractions
 * This should be used in all fraction update operations
 *
 * @param fractionId - The fraction ID to update
 * @returns A WHERE clause that includes safety checks
 */
export function createSafeFractionUpdateWhere(fractionId: string) {
  return and(
    eq(fractions.id, fractionId),
    eq(fractions.isFilled, false),
    not(eq(fractions.status, FRACTION_STATUS.FILLED))
  );
}

/**
 * Creates a new fraction entry in the database
 * Automatically generates a unique fraction ID using applicationId + nonce
 *
 * @param params - The parameters for creating the fraction
 * @returns The created fraction with the generated ID
 * @throws Error if the application already has a filled fraction
 */
export async function createFraction(params: CreateFractionParams, tx?: any) {
  // Check if the application already has a filled fraction
  const alreadyFilled = await hasFilledFraction(params.applicationId);
  const fractionType = params.type || "launchpad";
  if (alreadyFilled?.type === fractionType) {
    throw new Error(
      "Cannot create fraction: application already has a filled fraction"
    );
  }

  // Check if the user already has active fractions (draft or committed)
  // For launchpad fractions, we don't allow multiple active fractions
  // For mining-center fractions, we only check for other mining-center fractions
  // For launchpad-presale fractions, skip this check (foundation wallet may have multiple active fractions)

  if (fractionType !== "launchpad-presale") {
    const userHasActiveFractions = await hasActiveFractions(params.createdBy);

    if (userHasActiveFractions) {
      throw new Error(
        `Cannot create fraction: user already has an active ${fractionType} fraction (draft or committed)`
      );
    }
  }

  const { fractionId, nonce } = await generateUniqueFractionId(
    params.createdBy
  );

  const now = new Date();

  // Calculate expiration based on fraction type:
  // - mining-center: Following Saturday at 2:00 PM ET
  // - launchpad-presale: Next Tuesday at 12:00 PM EST
  // - launchpad: Standard lifetime (4 weeks)
  let expirationAt: Date;
  let token: string;
  if (fractionType === "mining-center") {
    token = forwarderAddresses.USDC;
    expirationAt = getNextSaturdayAt2PMET();
  } else if (fractionType === "launchpad-presale") {
    token = SGCTL_TOKEN_ADDRESS;
    expirationAt = getNextTuesdayNoonEST();
  } else {
    token = forwarderAddresses.GLW;
    expirationAt = new Date(now.getTime() + LAUNCHPAD_FRACTION_LIFETIME_MS);
  }

  // For launchpad-presale, we set isCommittedOnChain to true immediately
  // since it's an off-chain fraction and doesn't need on-chain commitment
  const isCommittedOnChain = fractionType === "launchpad-presale";
  const status =
    fractionType === "launchpad-presale"
      ? FRACTION_STATUS.COMMITTED
      : FRACTION_STATUS.DRAFT;

  const fractionData: FractionInsertType = {
    id: fractionId,
    applicationId: params.applicationId,
    nonce,
    createdBy: params.createdBy,
    sponsorSplitPercent: params.sponsorSplitPercent,
    step: params.stepPrice || null, // Store stepPrice in the step field
    stepPrice: params.stepPrice,
    totalSteps: params.totalSteps,
    rewardScore:
      fractionType === "launchpad" ? params.rewardScore ?? null : null, // Only save rewardScore for launchpad fractions
    createdAt: now,
    updatedAt: now,
    isCommittedOnChain,
    txHash: null,
    committedAt: isCommittedOnChain ? now : null,
    isFilled: false,
    filledAt: null,
    expirationAt,
    status,
    type: fractionType,
    // For launchpad-presale, set the SGCTL token address
    token,
    owner: params.createdBy,
  };

  const result = await (tx || db)
    .insert(fractions)
    .values(fractionData)
    .returning();

  return result[0];
}

/**
 * Updates a fraction when it's committed on-chain
 *
 * @param fractionId - The fraction ID
 * @param txHash - The transaction hash
 * @param token - The token address (GLW for launchpad, USDC for mining-center)
 * @param owner - The owner address
 * @param step - The price in token decimals for each fraction
 * @param totalSteps - The total number of steps
 */
export async function markFractionAsCommitted(
  fractionId: string,
  txHash: string,
  token: string,
  owner: string,
  step: string,
  totalSteps: number
) {
  return await db
    .update(fractions)
    .set({
      isCommittedOnChain: true,
      txHash,
      committedAt: new Date(),
      updatedAt: new Date(),
      token,
      owner,
      step,
      totalSteps,
      status: FRACTION_STATUS.COMMITTED,
    })
    .where(eq(fractions.id, fractionId))
    .returning();
}

/**
 * Updates a fraction when it's filled
 *
 * @param fractionId - The fraction ID
 */
export async function markFractionAsFilled(fractionId: string) {
  const result = await db
    .update(fractions)
    .set({
      isFilled: true,
      filledAt: new Date(),
      updatedAt: new Date(),
      status: FRACTION_STATUS.FILLED,
    })
    .where(eq(fractions.id, fractionId))
    .returning();

  // Send Slack notification when fraction is filled
  if (result[0] && process.env.SLACK_BOT_TOKEN) {
    try {
      const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);
      const fraction = result[0];
      const slackMessage =
        `🎉 *Fraction Manually Filled*\n\n` +
        `*Fraction ID:* ${fractionId}\n` +
        `*Application ID:* ${fraction.applicationId}\n` +
        `*Type:* ${fraction.type}\n` +
        `*Time:* ${new Date().toISOString()}\n` +
        `*Environment:* ${process.env.NODE_ENV || "unknown"}\n\n` +
        `_This fraction was marked as filled manually._`;

      await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
    } catch (slackError) {
      console.error(
        "[markFractionAsFilled] Failed to send Slack notification:",
        slackError
      );
      // Don't fail the operation if Slack notification fails
    }
  }

  return result;
}

export interface CreateFractionSplitParams {
  fractionId: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: number;
  creator: string;
  buyer: string;
  step: string;
  amount: string;
  stepsPurchased: number;
  timestamp: number;
}

export interface RecordFractionSplitResult {
  split: any | null;
  fraction: any;
  shouldCompleteApplication: boolean;
  wasAlreadyFilled?: boolean;
}

/**
 * Records a fraction split sale and increments the splitsSold counter
 * If splitsSold reaches totalSteps, marks the fraction as filled and completes the application
 *
 * @param params - The fraction split parameters from the blockchain event
 * @returns The created fraction split and updated fraction
 */
export async function recordFractionSplit(
  params: CreateFractionSplitParams
): Promise<RecordFractionSplitResult> {
  // First, check the fraction status before starting the transaction
  const fraction = await db
    .select()
    .from(fractions)
    .where(eq(fractions.id, params.fractionId))
    .limit(1);

  if (!fraction[0]) {
    throw new Error(`Fraction not found: ${params.fractionId}`);
  }

  // If fraction is already filled, this is likely a race condition where multiple events
  // were processed concurrently. This is not an error - just skip processing.
  if (fraction[0].status === FRACTION_STATUS.FILLED) {
    console.log(
      `[recordFractionSplit] Fraction ${params.fractionId} is already filled, skipping split processing (likely race condition)`
    );
    return {
      split: null,
      fraction: fraction[0],
      shouldCompleteApplication: false,
      wasAlreadyFilled: true,
    };
  }

  // Validate fraction is in a valid state to record splits
  if (fraction[0].status !== FRACTION_STATUS.COMMITTED) {
    throw new Error(
      `Cannot record split for fraction in status: ${fraction[0].status}. Fraction must be committed.`
    );
  }

  // Check if fraction has expired
  if (new Date() > fraction[0].expirationAt) {
    throw new Error(
      `Cannot record split for expired fraction: ${params.fractionId}`
    );
  }

  const transactionResult = await db.transaction(async (tx) => {
    // Insert the fraction split record
    const splitData: FractionSplitInsertType = {
      fractionId: params.fractionId,
      transactionHash: params.transactionHash,
      blockNumber: params.blockNumber,
      logIndex: params.logIndex,
      creator: params.creator,
      buyer: params.buyer,
      step: params.step,
      amount: params.amount,
      stepsPurchased: params.stepsPurchased,
      timestamp: params.timestamp,
      createdAt: new Date(),
    };

    const [createdSplit] = await tx
      .insert(fractionSplits)
      .values(splitData)
      .returning();

    // Increment the splitsSold counter by the number of steps purchased
    const [updatedFraction] = await tx
      .update(fractions)
      .set({
        splitsSold: sql`${fractions.splitsSold} + ${params.stepsPurchased}`,
        updatedAt: new Date(),
      })
      .where(eq(fractions.id, params.fractionId))
      .returning();

    // Check if the fraction is now fully filled
    if (
      updatedFraction.totalSteps &&
      updatedFraction.splitsSold >= updatedFraction.totalSteps &&
      updatedFraction.status !== FRACTION_STATUS.FILLED
    ) {
      // Mark as filled
      const [filledFraction] = await tx
        .update(fractions)
        .set({
          isFilled: true,
          filledAt: new Date(),
          updatedAt: new Date(),
          status: FRACTION_STATUS.FILLED,
        })
        .where(eq(fractions.id, params.fractionId))
        .returning();

      // Send Slack notification when fraction is filled
      if (process.env.SLACK_BOT_TOKEN) {
        try {
          const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);
          const slackMessage =
            `🎉 *Fraction Filled Successfully!*\n\n` +
            `*Fraction ID:* ${params.fractionId}\n` +
            `*Application ID:* ${filledFraction.applicationId}\n` +
            `*Total Steps:* ${filledFraction.totalSteps}\n` +
            `*Splits Sold:* ${filledFraction.splitsSold}\n` +
            `*Step Price:* ${filledFraction.step}\n` +
            `*Token:* ${filledFraction.token || "N/A"}\n` +
            `*Type:* ${filledFraction.type}\n` +
            `*Transaction:* ${params.transactionHash}\n` +
            `*Time:* ${new Date().toISOString()}\n` +
            `*Environment:* ${process.env.NODE_ENV || "unknown"}`;

          await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
        } catch (slackError) {
          console.error(
            "[recordFractionSplit] Failed to send Slack notification:",
            slackError
          );
          // Don't fail the operation if Slack notification fails
        }
      }

      return {
        split: createdSplit,
        fraction: filledFraction,
        shouldCompleteApplication: true,
      };
    }

    return {
      split: createdSplit,
      fraction: updatedFraction,
      shouldCompleteApplication: false,
    };
  });

  // If the fraction was just filled, complete the application
  if (transactionResult.shouldCompleteApplication) {
    try {
      // Get the application data
      const application = await FindFirstApplicationById(
        transactionResult.fraction.applicationId
      );

      if (!application) {
        console.error(
          "[recordFractionSplit] Application not found for fraction:",
          params.fractionId
        );
        return transactionResult;
      }

      // CRITICAL: Check if total raised across ALL fractions >= protocol fee
      // This prevents premature farm creation when only partial payment is made (e.g., 30% SGCTL presale)
      const { totalRaisedUSD, hasMultipleFractionTypes } =
        await getTotalRaisedForApplication(application.id);

      const requiredProtocolFee = BigInt(application.finalProtocolFeeBigInt);

      console.log(
        `[recordFractionSplit] Total raised: ${totalRaisedUSD.toString()}, Required: ${requiredProtocolFee.toString()}`
      );

      if (totalRaisedUSD < requiredProtocolFee) {
        console.log(
          `[recordFractionSplit] Insufficient funds raised. Total: ${totalRaisedUSD.toString()}, Required: ${requiredProtocolFee.toString()}. Farm creation deferred.`
        );
        return transactionResult;
      }

      // Complete the application if it has all required data
      if (application.gca?.id && application.user?.id) {
        if (
          application.auditFields?.devices &&
          application.auditFields?.devices.length > 0
        ) {
          // Determine payment currency based on whether multiple fraction types were used
          let paymentCurrency: string;
          if (hasMultipleFractionTypes) {
            paymentCurrency = "MIXED";
          } else if (transactionResult.fraction.type === "mining-center") {
            paymentCurrency = "USDC";
          } else if (transactionResult.fraction.type === "launchpad-presale") {
            paymentCurrency = "SGCTL";
          } else {
            paymentCurrency = "GLW";
          }

          // Use the completeApplicationAndCreateFarm helper which includes solar farm sync
          await completeApplicationAndCreateFarm({
            application,
            txHash: params.transactionHash,
            paymentDate: new Date(params.timestamp * 1000),
            paymentCurrency: paymentCurrency as any,
            paymentEventType: "OnchainFractionRoundFilled",
            paymentAmount: totalRaisedUSD.toString(),
            protocolFee: BigInt(application.finalProtocolFeeBigInt),
            protocolFeeAdditionalPaymentTxHash: null,
          });

          console.log(
            "[recordFractionSplit] Successfully completed application and created farm for fraction:",
            params.fractionId
          );
        }
      }

      // Emit fraction.closed event when filled
      try {
        const eventService = getFractionEventService();
        await eventService.emitFractionClosed({
          fractionId: params.fractionId,
          transactionHash: params.transactionHash,
          blockNumber: params.blockNumber,
          logIndex: params.logIndex,
          token: transactionResult.fraction.token || "",
          owner: transactionResult.fraction.owner || "",
          timestamp: params.timestamp,
        });
      } catch (eventError) {
        console.error(
          "[recordFractionSplit] Failed to emit fraction.closed event:",
          eventError
        );
        // Don't fail the operation if event emission fails
      }
    } catch (error) {
      console.error(
        "[recordFractionSplit] Error completing application for fraction:",
        params.fractionId,
        error
      );
      // Don't throw the error - the fraction split was recorded successfully
    }
  }

  return transactionResult;
}

/**
 * Gets the current splits sold count for a fraction
 *
 * @param fractionId - The fraction ID
 * @returns The current splits sold count
 */
export async function getFractionSplitsSold(fractionId: string) {
  const result = await db
    .select({ splitsSold: fractions.splitsSold })
    .from(fractions)
    .where(eq(fractions.id, fractionId))
    .limit(1);

  return result[0]?.splitsSold ?? 0;
}

/**
 * Marks a fraction as cancelled
 *
 * @param fractionId - The fraction ID
 * @returns The updated fraction
 */
export async function markFractionAsCancelled(fractionId: string) {
  return await db
    .update(fractions)
    .set({
      status: FRACTION_STATUS.CANCELLED,
      updatedAt: new Date(),
    })
    .where(eq(fractions.id, fractionId))
    .returning();
}

/**
 * Marks a fraction as expired
 *
 * @param fractionId - The fraction ID
 * @returns The updated fraction
 */
export async function markFractionAsExpired(fractionId: string) {
  return await db
    .update(fractions)
    .set({
      status: FRACTION_STATUS.EXPIRED,
      updatedAt: new Date(),
    })
    .where(eq(fractions.id, fractionId))
    .returning();
}
