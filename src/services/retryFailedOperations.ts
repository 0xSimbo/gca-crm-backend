import {
  getPendingFailedOperations,
  updateFailedOperationRetry,
  markOperationsAsFailed,
  getFailedOperationById,
  manuallyRetryFailedOperation,
} from "../db/mutations/fractions/failedFractionOperations";
import {
  recordFractionSplit,
  CreateFractionSplitParams,
  markFractionAsCommitted,
  markFractionAsCancelled,
} from "../db/mutations/fractions/createFraction";

/**
 * Retries a single failed operation
 */
async function retrySingleOperation(operation: any) {
  console.log(
    `[retrySingleOperation] Retrying ${operation.operationType} for fraction ${
      operation.fractionId || "N/A"
    }`
  );

  try {
    switch (operation.operationType) {
      case "split":
        if (operation.eventPayload) {
          const payload = operation.eventPayload as any;
          const splitParams: CreateFractionSplitParams = {
            fractionId: payload.fractionId,
            transactionHash: payload.transactionHash,
            blockNumber: payload.blockNumber,
            logIndex: payload.logIndex,
            creator: payload.creator,
            buyer: payload.buyer,
            step: payload.step,
            amount: payload.amount,
            timestamp: payload.timestamp,
          };
          await recordFractionSplit(splitParams);
        }
        break;

      case "commit":
        if (operation.eventPayload && operation.fractionId) {
          const payload = operation.eventPayload as any;
          await markFractionAsCommitted(
            payload.fractionId,
            payload.transactionHash,
            payload.token,
            payload.owner,
            payload.step,
            parseInt(payload.totalSteps)
          );
        }
        break;

      case "cancel":
        if (operation.fractionId) {
          await markFractionAsCancelled(operation.fractionId);
        }
        break;

      default:
        throw new Error(`Unknown operation type: ${operation.operationType}`);
    }

    // Mark as resolved
    await updateFailedOperationRetry(operation.id, "resolved");

    console.log(
      `[retrySingleOperation] Successfully resolved ${
        operation.operationType
      } for fraction ${operation.fractionId || "N/A"}`
    );

    return { success: true };
  } catch (error) {
    console.error(
      `[retrySingleOperation] Failed to retry ${
        operation.operationType
      } for fraction ${operation.fractionId || "N/A"}:`,
      error
    );

    // Update with new error
    const newRetryCount = operation.retryCount + 1;
    const status =
      newRetryCount >= operation.maxRetries ? "failed" : "retrying";
    await updateFailedOperationRetry(
      operation.id,
      status as "failed" | "retrying",
      error as Error
    );

    return { success: false, error, permanentlyFailed: status === "failed" };
  }
}

/**
 * Retries failed fraction operations
 * This should be run periodically via a cron job
 */
export async function retryFailedOperations() {
  console.log("[retryFailedOperations] Starting retry process...");

  try {
    // First, mark any operations that have exceeded max retries as failed
    const permanentlyFailed = await markOperationsAsFailed();
    if (permanentlyFailed.length > 0) {
      console.log(
        `[retryFailedOperations] Marked ${permanentlyFailed.length} operations as permanently failed`
      );
    }

    // Get pending operations to retry
    const pendingOperations = await getPendingFailedOperations(20);

    if (pendingOperations.length === 0) {
      console.log("[retryFailedOperations] No pending operations to retry");
      return { retried: 0, resolved: 0, failed: 0 };
    }

    console.log(
      `[retryFailedOperations] Found ${pendingOperations.length} operations to retry`
    );

    let retriedCount = 0;
    let resolvedCount = 0;
    let failedCount = 0;

    for (const operation of pendingOperations) {
      // Update status to retrying
      await updateFailedOperationRetry(operation.id, "retrying");
      retriedCount++;

      const result = await retrySingleOperation(operation);

      if (result.success) {
        resolvedCount++;
      } else if (result.permanentlyFailed) {
        failedCount++;
      }
    }

    console.log(
      `[retryFailedOperations] Completed: ${retriedCount} retried, ${resolvedCount} resolved, ${failedCount} failed`
    );

    return {
      retried: retriedCount,
      resolved: resolvedCount,
      failed: failedCount,
    };
  } catch (error) {
    console.error("[retryFailedOperations] Error in retry process:", error);
    throw error;
  }
}

/**
 * Manually retries a specific failed operation by ID
 */
export async function manualRetryFailedOperation(operationId: number) {
  console.log(
    `[manualRetryFailedOperation] Manual retry for operation ${operationId}`
  );

  try {
    // Get the operation
    const operation = await getFailedOperationById(operationId);

    if (!operation) {
      throw new Error(`Failed operation with id ${operationId} not found`);
    }

    if (operation.status === "resolved") {
      throw new Error(`Operation ${operationId} is already resolved`);
    }

    // Reset the operation for manual retry
    await manuallyRetryFailedOperation(operationId);

    // Get the updated operation
    const updatedOperation = await getFailedOperationById(operationId);

    if (!updatedOperation) {
      throw new Error(`Failed to retrieve updated operation ${operationId}`);
    }

    // Update status to retrying
    await updateFailedOperationRetry(updatedOperation.id, "retrying");

    // Retry the operation
    const result = await retrySingleOperation(updatedOperation);

    return {
      operationId: operationId,
      operationType: updatedOperation.operationType,
      fractionId: updatedOperation.fractionId,
      success: result.success,
      error: result.success ? null : result.error,
      status: result.success
        ? "resolved"
        : result.permanentlyFailed
        ? "failed"
        : "pending",
    };
  } catch (error) {
    console.error(
      `[manualRetryFailedOperation] Error retrying operation ${operationId}:`,
      error
    );
    throw error;
  }
}
