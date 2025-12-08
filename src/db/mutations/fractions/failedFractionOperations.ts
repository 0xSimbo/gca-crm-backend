import { db } from "../../db";
import {
  failedFractionOperations,
  FailedFractionOperationInsertType,
} from "../../schema";
import { eq, and, lt, inArray, sql } from "drizzle-orm";
import { createSlackClient } from "../../../slack/create-slack-client";

const SLACK_CHANNEL = "#devs";

export interface RecordFailedOperationParams {
  fractionId?: string;
  operationType:
    | "create"
    | "commit"
    | "fill"
    | "split"
    | "expire"
    | "cancel"
    | "refund"
    | "finalize";
  eventType?: string;
  eventPayload?: any;
  error: Error;
  maxRetries?: number;
}

/**
 * Records a failed fraction operation for monitoring and retry
 * Also sends a Slack notification for critical failures
 */
export async function recordFailedFractionOperation(
  params: RecordFailedOperationParams
) {
  const failedOperation: FailedFractionOperationInsertType = {
    fractionId: params.fractionId,
    operationType: params.operationType,
    eventType: params.eventType,
    eventPayload: params.eventPayload,
    errorMessage: params.error.message,
    errorStack: params.error.stack,
    maxRetries: params.maxRetries || 1, // Only retry once automatically
    status: "pending",
  };

  const [inserted] = await db
    .insert(failedFractionOperations)
    .values(failedOperation)
    .returning();

  // Send Slack notification for critical failures
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);

      const slackMessage =
        `🚨 *Failed Fraction Operation Alert*\n\n` +
        `*Operation Type:* ${params.operationType}\n` +
        `*Fraction ID:* ${params.fractionId || "N/A"}\n` +
        `*Event Type:* ${params.eventType || "N/A"}\n` +
        `*Error:* ${params.error.message}\n` +
        `*Time:* ${new Date().toISOString()}\n` +
        `*Environment:* ${process.env.NODE_ENV || "unknown"}\n\n` +
        `_This operation has been queued for retry._`;

      await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
    } catch (slackError) {
      console.error(
        "[recordFailedFractionOperation] Failed to send Slack notification:",
        slackError
      );
    }
  }

  return inserted;
}

/**
 * Gets pending failed operations for retry
 */
export async function getPendingFailedOperations(limit: number = 10) {
  return await db
    .select()
    .from(failedFractionOperations)
    .where(
      and(
        inArray(failedFractionOperations.status, ["pending", "retrying"]),
        lt(
          failedFractionOperations.retryCount,
          failedFractionOperations.maxRetries
        )
      )
    )
    .orderBy(failedFractionOperations.createdAt)
    .limit(limit);
}

/**
 * Updates the retry count and status of a failed operation
 */
export async function updateFailedOperationRetry(
  id: number,
  status: "retrying" | "failed" | "resolved",
  error?: Error
) {
  const updateData: any = {
    status,
    updatedAt: new Date(),
    retryCount:
      status === "retrying"
        ? sql`${failedFractionOperations.retryCount} + 1`
        : undefined,
  };

  if (status === "resolved") {
    updateData.resolvedAt = new Date();
  }

  if (error) {
    updateData.errorMessage = error.message;
    updateData.errorStack = error.stack;
  }

  const [updated] = await db
    .update(failedFractionOperations)
    .set(updateData)
    .where(eq(failedFractionOperations.id, id))
    .returning();

  // Send Slack notification when an operation is resolved after retry
  if (status === "resolved" && process.env.SLACK_BOT_TOKEN) {
    try {
      const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);

      const slackMessage =
        `✅ *Failed Operation Resolved*\n\n` +
        `*Operation Type:* ${updated.operationType}\n` +
        `*Fraction ID:* ${updated.fractionId || "N/A"}\n` +
        `*Retry Count:* ${updated.retryCount}\n` +
        `*Resolved At:* ${new Date().toISOString()}`;

      await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
    } catch (slackError) {
      console.error(
        "[updateFailedOperationRetry] Failed to send Slack notification:",
        slackError
      );
    }
  }

  return updated;
}

/**
 * Marks operations as permanently failed after max retries
 */
export async function markOperationsAsFailed() {
  const failedOps = await db
    .update(failedFractionOperations)
    .set({
      status: "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(failedFractionOperations.status, ["pending", "retrying"]),
        sql`${failedFractionOperations.retryCount} >= ${failedFractionOperations.maxRetries}`
      )
    )
    .returning();

  // Send Slack notification for permanently failed operations
  if (failedOps.length > 0 && process.env.SLACK_BOT_TOKEN) {
    try {
      const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);

      const slackMessage =
        `❌ *Operations Permanently Failed*\n\n` +
        `*Count:* ${failedOps.length} operations\n` +
        `*Operations:*\n` +
        failedOps
          .map(
            (op) =>
              `• ${op.operationType} for fraction ${op.fractionId || "N/A"} (${
                op.retryCount
              } retries)`
          )
          .join("\n") +
        `\n\n_Manual intervention required._`;

      await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
    } catch (slackError) {
      console.error(
        "[markOperationsAsFailed] Failed to send Slack notification:",
        slackError
      );
    }
  }

  return failedOps;
}

/**
 * Gets a failed operation by ID
 */
export async function getFailedOperationById(id: number) {
  const [operation] = await db
    .select()
    .from(failedFractionOperations)
    .where(eq(failedFractionOperations.id, id))
    .limit(1);

  return operation;
}

/**
 * Manually retries a failed operation
 */
export async function manuallyRetryFailedOperation(id: number) {
  const operation = await getFailedOperationById(id);

  if (!operation) {
    throw new Error(`Failed operation with id ${id} not found`);
  }

  if (operation.status === "resolved") {
    throw new Error(`Operation ${id} is already resolved`);
  }

  // Reset the operation for manual retry
  const [updated] = await db
    .update(failedFractionOperations)
    .set({
      status: "pending",
      updatedAt: new Date(),
    })
    .where(eq(failedFractionOperations.id, id))
    .returning();

  return updated;
}
