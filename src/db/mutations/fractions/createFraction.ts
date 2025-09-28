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
} from "../../../constants/fractions";
import {
  hasFilledFraction,
  hasActiveFractions,
} from "../../queries/fractions/findFractionsByApplicationId";
import { FindFirstApplicationById } from "../../queries/applications/findFirstApplicationById";
import { getFractionEventService } from "../../../services/eventListener";
import { completeApplicationAndCreateFarm } from "../../../routers/applications-router/publicRoutes";
import { createSlackClient } from "../../../slack/create-slack-client";

const SLACK_CHANNEL = "#devs";

export interface CreateFractionParams {
  applicationId: string;
  createdBy: string;
  sponsorSplitPercent: number;
  stepPrice: string; // Price per step in token decimals
  rewardScore?: number; // Reward score for launchpad fractions (optional, only used for launchpad type, e.g., 50, 100, 200)
  type?: "launchpad" | "mining-center";
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
  if (alreadyFilled) {
    throw new Error(
      "Cannot create fraction: application already has a filled fraction"
    );
  }

  // Check if the user already has active fractions (draft or committed)
  // For launchpad fractions, we don't allow multiple active fractions
  // For mining-center fractions, we only check for other mining-center fractions
  const fractionType = params.type || "launchpad";
  const userHasActiveFractions = await hasActiveFractions(params.createdBy);

  if (userHasActiveFractions) {
    throw new Error(
      `Cannot create fraction: user already has an active ${fractionType} fraction (draft or committed)`
    );
  }

  const { fractionId, nonce } = await generateUniqueFractionId(
    params.createdBy
  );

  const now = new Date();
  const expirationAt = new Date(
    now.getTime() +
      (fractionType === "mining-center"
        ? MINING_CENTER_FRACTION_LIFETIME_MS
        : LAUNCHPAD_FRACTION_LIFETIME_MS)
  );

  const fractionData: FractionInsertType = {
    id: fractionId,
    applicationId: params.applicationId,
    nonce,
    createdBy: params.createdBy,
    sponsorSplitPercent: params.sponsorSplitPercent,
    step: params.stepPrice || null, // Store stepPrice in the step field
    stepPrice: params.stepPrice,
    rewardScore:
      fractionType === "launchpad" ? params.rewardScore ?? null : null, // Only save rewardScore for launchpad fractions
    createdAt: now,
    updatedAt: now,
    isCommittedOnChain: false,
    txHash: null,
    committedAt: null,
    isFilled: false,
    filledAt: null,
    expirationAt,
    status: FRACTION_STATUS.DRAFT,
    type: fractionType,
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

      // Calculate payment amount (step * totalSteps)
      const stepBigInt = BigInt(transactionResult.fraction.step!);
      const totalStepsBigInt = BigInt(transactionResult.fraction.totalSteps!);
      const paymentAmount = (stepBigInt * totalStepsBigInt).toString();

      // Complete the application if it has all required data
      if (application.gca?.id && application.user?.id) {
        if (
          application.auditFields?.devices &&
          application.auditFields?.devices.length > 0
        ) {
          // Determine payment currency based on fraction type
          const paymentCurrency =
            transactionResult.fraction.type === "mining-center"
              ? "USDC"
              : "GLW";

          // Use the completeApplicationAndCreateFarm helper which includes solar farm sync
          await completeApplicationAndCreateFarm({
            application,
            txHash: params.transactionHash,
            paymentDate: new Date(params.timestamp * 1000),
            paymentCurrency,
            paymentEventType: "OnchainFractionRoundFilled",
            paymentAmount: paymentAmount,
            protocolFee: BigInt(application.finalProtocolFeeBigInt),
            protocolFeeAdditionalPaymentTxHash: null,
            payer: transactionResult.fraction.owner!,
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
