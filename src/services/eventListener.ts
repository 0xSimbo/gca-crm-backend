import {
  createGlowEventListener,
  createGlowEventEmitter,
  getZoneId,
} from "@glowlabs-org/events-sdk";
import {
  recordFractionSplit,
  CreateFractionSplitParams,
  markFractionAsCommitted,
  markFractionAsCancelled,
} from "../db/mutations/fractions/createFraction";
import {
  findFractionSplitByTxHash,
  calculateStepsPurchased,
} from "../db/queries/fractions/findFractionSplits";
import { findFractionById } from "../db/queries/fractions/findFractionsByApplicationId";
import { forwarderAddresses } from "../constants/addresses";
import { FRACTION_STATUS } from "../constants/fractions";
import { recordFailedFractionOperation } from "../db/mutations/fractions/failedFractionOperations";
import { verifyFractionSoldTransaction } from "../utils/verifyFractionTransaction";

export class FractionEventService {
  private listener?: ReturnType<typeof createGlowEventListener>;
  private emitter?: ReturnType<typeof createGlowEventEmitter>;
  private isListening = false;

  constructor() {}

  /**
   * Initialize the event listener for fraction events
   */
  async startListener() {
    if (this.isListening) {
      console.log("[FractionEventService] Listener already running");
      return;
    }

    if (
      !process.env.RABBITMQ_ADMIN_USER ||
      !process.env.RABBITMQ_ADMIN_PASSWORD ||
      !process.env.RABBITMQ_QUEUE_NAME
    ) {
      throw new Error(
        "RABBITMQ_ADMIN_USER, RABBITMQ_ADMIN_PASSWORD, and RABBITMQ_QUEUE_NAME must be set"
      );
    }

    if (!process.env.NODE_ENV) {
      throw new Error("NODE_ENV must be set");
    }

    const environment =
      process.env.NODE_ENV === "production" ? "production" : "staging";

    this.listener = createGlowEventListener({
      username: process.env.RABBITMQ_ADMIN_USER,
      password: process.env.RABBITMQ_ADMIN_PASSWORD,
      queueName: process.env.RABBITMQ_QUEUE_NAME,
      zoneId: 0,
    });

    // Listen for fraction.sold events
    this.listener.onEvent("fraction.sold", "v2-alpha", async (event) => {
      try {
        console.log(
          "[FractionEventService] Received fraction.sold event:",
          event.payload.fractionId
        );

        if (event.environment !== environment) {
          return;
        }

        // Check if we already processed this event (idempotency)
        const existingSplit = await findFractionSplitByTxHash(
          event.payload.transactionHash,
          event.payload.logIndex
        );

        if (existingSplit) {
          console.log(
            "[FractionEventService] Split already processed, skipping:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          return;
        }

        // CRITICAL: Verify the event payload against on-chain transaction data
        const verification = await verifyFractionSoldTransaction(event.payload);
        if (!verification.isValid) {
          console.error(
            "[FractionEventService] Transaction verification failed:",
            verification.error,
            "Event payload:",
            event.payload
          );

          // Record this as a failed operation for investigation
          await recordFailedFractionOperation({
            fractionId: event.payload.fractionId,
            operationType: "split",
            eventType: "fraction.sold",
            eventPayload: event.payload,
            error: new Error(
              `Transaction verification failed: ${verification.error}`
            ),
          });
          return;
        }

        console.log(
          "[FractionEventService] Transaction verification passed for:",
          event.payload.transactionHash,
          event.payload.logIndex
        );

        // Calculate steps purchased from step price and amount
        const stepsPurchased = calculateStepsPurchased(
          event.payload.step,
          event.payload.amount
        );

        // Record the fraction split
        const params: CreateFractionSplitParams = {
          fractionId: event.payload.fractionId,
          transactionHash: event.payload.transactionHash,
          blockNumber: event.payload.blockNumber,
          logIndex: event.payload.logIndex,
          creator: event.payload.creator,
          buyer: event.payload.buyer,
          step: event.payload.step,
          amount: event.payload.amount,
          stepsPurchased: stepsPurchased,
          timestamp: event.payload.timestamp,
        };

        const result = await recordFractionSplit(params);

        if (result.fraction.isFilled) {
          console.log(
            "[FractionEventService] Fraction is now fully filled:",
            event.payload.fractionId
          );
        }

        console.log(
          "[FractionEventService] Successfully processed fraction.sold event for:",
          event.payload.fractionId
        );
      } catch (error: any) {
        // Check if this is a duplicate key error
        if (
          error.code === "23505" ||
          error.message?.includes("duplicate key")
        ) {
          console.log(
            "[FractionEventService] Duplicate fraction split detected (likely due to concurrent processing), ignoring:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          // This is not a real error - the split was already recorded
          return;
        }

        console.error(
          "[FractionEventService] Error processing fraction.sold event:",
          error
        );

        // Only record as failed operation if it's not a duplicate key error
        try {
          await recordFailedFractionOperation({
            fractionId: event.payload.fractionId,
            operationType: "split",
            eventType: "fraction.sold",
            eventPayload: event.payload,
            error: error as Error,
          });
        } catch (recordError) {
          console.error(
            "[FractionEventService] Failed to record failed operation:",
            recordError
          );
        }
      }
    });

    // Listen for fraction.created events and mark as committed
    this.listener.onEvent("fraction.created", "v2-alpha", async (event) => {
      try {
        console.log(
          "[FractionEventService] Received fraction.created event:",
          event.payload.fractionId,
          "with",
          event.payload.totalSteps,
          "total steps"
        );

        if (event.environment !== environment) {
          return;
        }

        // Find the fraction in the database
        const fraction = await findFractionById(event.payload.fractionId);
        if (!fraction) {
          console.error(
            "[FractionEventService] Fraction not found:",
            event.payload.fractionId
          );
          return;
        }

        // Check if already committed to avoid duplicate processing
        if (fraction.isCommittedOnChain) {
          console.log(
            "[FractionEventService] Fraction already committed, skipping:",
            event.payload.fractionId
          );
          return;
        }

        // Validate token address is GLW
        const glwAddress = forwarderAddresses.GLW.toLowerCase();
        if (event.payload.token.toLowerCase() !== glwAddress) {
          console.error(
            "[FractionEventService] Invalid token address:",
            event.payload.token,
            "Expected GLW:",
            forwarderAddresses.GLW
          );
          return;
        }

        // Validate owner matches the fraction creator
        if (
          event.payload.owner.toLowerCase() !== fraction.createdBy.toLowerCase()
        ) {
          console.error(
            "[FractionEventService] Owner mismatch:",
            event.payload.owner,
            "does not match fraction creator:",
            fraction.createdBy
          );
          return;
        }

        // Mark fraction as committed
        await markFractionAsCommitted(
          event.payload.fractionId,
          event.payload.transactionHash,
          event.payload.token,
          event.payload.owner,
          event.payload.step,
          parseInt(event.payload.totalSteps)
        );

        console.log(
          "[FractionEventService] Successfully marked fraction as committed:",
          event.payload.fractionId
        );
      } catch (error: any) {
        // Check if this is a duplicate key error or already committed error
        if (
          error.code === "23505" ||
          error.message?.includes("duplicate key") ||
          error.message?.includes("already committed")
        ) {
          console.log(
            "[FractionEventService] Fraction already committed (likely due to concurrent processing), ignoring:",
            event.payload.fractionId
          );
          // This is not a real error - the fraction was already committed
          return;
        }

        console.error(
          "[FractionEventService] Error processing fraction.created event:",
          error
        );

        // Only record as failed operation if it's not a duplicate/already committed error
        try {
          await recordFailedFractionOperation({
            fractionId: event.payload.fractionId,
            operationType: "commit",
            eventType: "fraction.created",
            eventPayload: event.payload,
            error: error as Error,
          });
        } catch (recordError) {
          console.error(
            "[FractionEventService] Failed to record failed operation:",
            recordError
          );
        }
      }
    });

    // Listen for fraction.closed events
    this.listener.onEvent("fraction.closed", "v2-alpha", async (event) => {
      try {
        console.log(
          "[FractionEventService] Received fraction.closed event:",
          event.payload.fractionId
        );

        if (event.environment !== environment) {
          return;
        }

        // Get the fraction to check its current status
        const fraction = await findFractionById(event.payload.fractionId);
        if (!fraction) {
          console.error(
            "[FractionEventService] Fraction not found for closed event:",
            event.payload.fractionId
          );
          return;
        }

        // Only mark as cancelled if it's not already filled
        // (fraction.closed could be emitted for both filled and cancelled fractions)
        if (fraction.status !== FRACTION_STATUS.FILLED) {
          await markFractionAsCancelled(event.payload.fractionId);
          console.log(
            "[FractionEventService] Marked fraction as cancelled:",
            event.payload.fractionId
          );
        } else {
          console.log(
            "[FractionEventService] Fraction already filled, skipping cancellation:",
            event.payload.fractionId
          );
        }
      } catch (error: any) {
        // Check if this is a duplicate key error or already processed error
        if (
          error.code === "23505" ||
          error.message?.includes("duplicate key") ||
          error.message?.includes("already cancelled") ||
          error.message?.includes("already filled")
        ) {
          console.log(
            "[FractionEventService] Fraction status already updated (likely due to concurrent processing), ignoring:",
            event.payload.fractionId
          );
          // This is not a real error - the status was already updated
          return;
        }

        console.error(
          "[FractionEventService] Error processing fraction.closed event:",
          error
        );

        // Only record as failed operation if it's not a duplicate/already processed error
        try {
          await recordFailedFractionOperation({
            fractionId: event.payload.fractionId,
            operationType: "cancel",
            eventType: "fraction.closed",
            eventPayload: event.payload,
            error: error as Error,
          });
        } catch (recordError) {
          console.error(
            "[FractionEventService] Failed to record failed operation:",
            recordError
          );
        }
      }
    });

    await this.listener.start();
    this.isListening = true;
    console.log("[FractionEventService] Event listener started");
  }

  /**
   * Stop the event listener
   */
  async stopListener() {
    if (!this.isListening || !this.listener) {
      console.log("[FractionEventService] Listener not running");
      return;
    }

    await this.listener.stop();
    this.isListening = false;
    console.log("[FractionEventService] Event listener stopped");
  }

  /**
   * Get the event emitter for emitting events
   */
  getEmitter(): ReturnType<typeof createGlowEventEmitter> {
    if (!this.emitter) {
      if (
        !process.env.RABBITMQ_ADMIN_USER ||
        !process.env.RABBITMQ_ADMIN_PASSWORD
      ) {
        throw new Error(
          "RABBITMQ_ADMIN_USER and RABBITMQ_ADMIN_PASSWORD must be set"
        );
      }
      this.emitter = createGlowEventEmitter({
        username: process.env.RABBITMQ_ADMIN_USER,
        password: process.env.RABBITMQ_ADMIN_PASSWORD,
        zoneId: 0,
        environment:
          process.env.NODE_ENV === "production" ? "production" : "staging",
      });
    }
    return this.emitter;
  }

  /**
   * Emit a fraction.created event
   */
  async emitFractionCreated(payload: {
    fractionId: string;
    transactionHash: string;
    blockNumber: string;
    logIndex: number;
    token: string;
    owner: string;
    step: string;
    totalSteps: string;
  }) {
    const emitter = this.getEmitter();
    await emitter.emit({
      eventType: "fraction.created",
      schemaVersion: "v2-alpha",
      payload,
    });
    console.log(
      "[FractionEventService] Emitted fraction.created event:",
      payload.fractionId
    );
  }

  /**
   * Emit a fraction.closed event
   */
  async emitFractionClosed(payload: {
    fractionId: string;
    transactionHash: string;
    blockNumber: string;
    logIndex: number;
    token: string;
    owner: string;
    timestamp: number;
  }) {
    const emitter = this.getEmitter();
    await emitter.emit({
      eventType: "fraction.closed",
      schemaVersion: "v2-alpha",
      payload,
    });
    console.log(
      "[FractionEventService] Emitted fraction.closed event:",
      payload.fractionId
    );
  }

  /**
   * Disconnect the emitter
   */
  async disconnect() {
    if (this.emitter) {
      await this.emitter.disconnect();
    }
  }

  /**
   * Check if the listener is currently running
   */
  isRunning() {
    return this.isListening;
  }
}

// Singleton instance for the service
let fractionEventService: FractionEventService | null = null;

/**
 * Initialize the fraction event service
 */
export function initializeFractionEventService() {
  if (fractionEventService) {
    console.log("[FractionEventService] Service already initialized");
    return fractionEventService;
  }

  fractionEventService = new FractionEventService();
  return fractionEventService;
}

/**
 * Get the initialized fraction event service
 */
export function getFractionEventService() {
  if (!fractionEventService) {
    throw new Error(
      "FractionEventService not initialized. Call initializeFractionEventService first."
    );
  }
  return fractionEventService;
}
