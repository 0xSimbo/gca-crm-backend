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
import { FindFirstApplicationById } from "../db/queries/applications/findFirstApplicationById";
import { db } from "../db/db";
import { fractionSplits } from "../db/schema";
import { eq } from "drizzle-orm";
import { forwarderAddresses } from "../constants/addresses";
import { FRACTION_STATUS } from "../constants/fractions";
import { recordFailedFractionOperation } from "../db/mutations/fractions/failedFractionOperations";
import { verifyFractionSoldTransaction } from "../utils/verifyFractionTransaction";
import {
  recordFractionRefund,
  findFractionRefundByTxHash,
} from "../db/mutations/fractions/recordFractionRefund";

export interface FractionEventServiceHealth {
  isListening: boolean;
  listenerStartedAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  lastEventFractionId: string | null;
  listenerError: string | null;
  listenerErrorAt: string | null;
}

export class FractionEventService {
  private listener?: ReturnType<typeof createGlowEventListener>;
  private emitter?: ReturnType<typeof createGlowEventEmitter>;
  private isListening = false;
  private listenerStartedAtMs: number | null = null;
  private lastEventAtMs: number | null = null;
  private lastEventType: string | null = null;
  private lastEventFractionId: string | null = null;
  private listenerError: string | null = null;
  private listenerErrorAtMs: number | null = null;

  constructor() {}

  private toIsoTimestamp(ms: number | null): string | null {
    return ms == null ? null : new Date(ms).toISOString();
  }

  private markEventReceived(eventType: string, fractionId?: string): void {
    this.lastEventAtMs = Date.now();
    this.lastEventType = eventType;
    this.lastEventFractionId = fractionId ?? null;
  }

  private markListenerError(context: string, error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : JSON.stringify(error);
    this.listenerError = `[${context}] ${message}`;
    this.listenerErrorAtMs = Date.now();
  }

  private clearListenerError(): void {
    this.listenerError = null;
    this.listenerErrorAtMs = null;
  }

  private shouldLogExpectedEvents(): boolean {
    return process.env.FRACTION_EVENT_VERBOSE_EXPECTED === "true";
  }

  private logExpected(message: string, ...args: unknown[]): void {
    if (!this.shouldLogExpectedEvents()) {
      return;
    }
    console.log(message, ...args);
  }

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
      if (event.environment !== environment) {
        return;
      }
      this.markEventReceived("fraction.sold", event.payload.fractionId);

      try {
        // Check if we already processed this event (idempotency)
        const existingSplit = await findFractionSplitByTxHash(
          event.payload.transactionHash,
          event.payload.logIndex
        );

        if (existingSplit) {
          this.logExpected(
            "[FractionEventService] Split already processed, skipping:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          return;
        }

        console.log(
          "[FractionEventService] Received fraction.sold event:",
          event.payload.fractionId
        );

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

        this.logExpected(
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

        // If no split was created, this was likely a duplicate delivery/race condition.
        if (!result.split) {
          this.logExpected(
            "[FractionEventService] Split not created (already processed/filled), skipping post-processing:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          if (result.wasAlreadyFilled) {
            this.logExpected(
              "[FractionEventService] Fraction was already filled, skipped processing (race condition):",
              event.payload.fractionId
            );
          }
          return;
        }

        // Snapshot reward score for launchpad fractions on each sale
        try {
          if (result?.fraction && result.fraction.type === "launchpad") {
            // Gather inputs for control API
            const application = await FindFirstApplicationById(
              result.fraction.applicationId
            );

            const expectedWeeklyCarbonCredits = Number(
              application?.auditFields?.netCarbonCreditEarningWeekly || 0
            );

            const regionId = application?.zoneId;

            const stepStr = (result.fraction.step ||
              result.fraction.stepPrice ||
              "0") as string;
            const totalStepsNum = Number(result.fraction.totalSteps || 0);

            let protocolDepositAmount = "0";
            try {
              protocolDepositAmount = (
                BigInt(stepStr) * BigInt(totalStepsNum)
              ).toString();
            } catch {
              protocolDepositAmount = "0";
            }
            this.logExpected(
              "[reward score] expectedWeeklyCarbonCredits",
              expectedWeeklyCarbonCredits
            );
            this.logExpected("[reward score] regionId", regionId);
            this.logExpected(
              "[reward score] protocolDepositAmount",
              protocolDepositAmount
            );
            if (
              expectedWeeklyCarbonCredits > 0 &&
              regionId &&
              protocolDepositAmount !== "0"
            ) {
              if (!process.env.CONTROL_API_URL) {
                console.warn(
                  "[FractionEventService] CONTROL_API_URL not set; skipping reward score snapshot"
                );
                return;
              }
              const body = {
                userId: result.fraction.createdBy,
                sponsorSplitPercent: result.fraction.sponsorSplitPercent,
                protocolDepositAmount,
                paymentCurrency: "GLW" as const,
                expectedWeeklyCarbonCredits,
                regionId,
              };

              try {
                const resp = await fetch(
                  `${process.env.CONTROL_API_URL}/farms/estimate-reward-score`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  }
                );

                if (resp.ok) {
                  const data = await resp.json();
                  const rawScore =
                    (data && (data.rewardScore ?? data.data?.rewardScore)) || 0;
                  const parsed = Number(rawScore);
                  const rewardScore = Number.isFinite(parsed)
                    ? Math.ceil(parsed)
                    : 0;

                  // Persist snapshot on the just-created split (only if > 0)
                  if (rewardScore > 0 && result.split?.id !== undefined) {
                    await db
                      .update(fractionSplits)
                      .set({ rewardScore })
                      .where(eq(fractionSplits.id, result.split.id));
                  }

                  console.log(
                    "[FractionEventService] Split rewardScore snapshot result:",
                    rewardScore
                  );
                } else {
                  const errText = await resp.text().catch(() => "");
                  console.warn(
                    "[FractionEventService] Failed to fetch reward score (non-OK):",
                    resp.status,
                    errText
                  );
                }
              } catch (apiErr) {
                console.warn(
                  "[FractionEventService] Control API call failed for reward score:",
                  apiErr
                );
              }
            }
          }
        } catch (snapshotErr) {
          console.warn(
            "[FractionEventService] Failed to snapshot reward score:",
            snapshotErr
          );
        }

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
        // Check if this is a duplicate key error or race condition
        if (
          error.code === "23505" ||
          error.message?.includes("duplicate key")
        ) {
          this.logExpected(
            "[FractionEventService] Duplicate fraction split detected (likely due to concurrent processing), ignoring:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          // This is not a real error - the split was already recorded
          return;
        }

        // Check if this is a race condition where fraction is already filled
        if (
          error.message?.includes(
            "Cannot record split for fraction in status: filled"
          ) ||
          error.message?.includes("fraction is already filled")
        ) {
          this.logExpected(
            "[FractionEventService] Fraction already filled (race condition), ignoring:",
            event.payload.fractionId,
            event.payload.transactionHash
          );
          // This is not a real error - just a race condition
          return;
        }

        console.error(
          "[FractionEventService] Error processing fraction.sold event:",
          error
        );

        // Only record as failed operation if it's not a duplicate key error or race condition
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
        if (event.environment !== environment) {
          return;
        }
        this.markEventReceived("fraction.created", event.payload.fractionId);
        console.log(
          "[FractionEventService] Received fraction.created event:",
          event.payload.fractionId,
          "with",
          event.payload.totalSteps,
          "total steps"
        );

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
          this.logExpected(
            "[FractionEventService] Fraction already committed, skipping:",
            event.payload.fractionId
          );
          return;
        }

        // Validate token address is GLW or USDC (for mining-center fractions)
        const glwAddress = forwarderAddresses.GLW.toLowerCase();
        const usdcAddress = forwarderAddresses.USDC.toLowerCase();
        const validTokens = [glwAddress, usdcAddress];

        if (!validTokens.includes(event.payload.token.toLowerCase())) {
          console.error(
            "[FractionEventService] Invalid token address:",
            event.payload.token,
            "Expected GLW or USDC:",
            { GLW: forwarderAddresses.GLW, USDC: forwarderAddresses.USDC }
          );
          return;
        }

        // Check if the token matches the fraction type
        const isUsdcToken = event.payload.token.toLowerCase() === usdcAddress;
        const isMiningCenterFraction = fraction.type === "mining-center";

        if (isUsdcToken && !isMiningCenterFraction) {
          console.error(
            "[FractionEventService] USDC token used for non-mining-center fraction:",
            event.payload.fractionId,
            "Fraction type:",
            fraction.type
          );
          return;
        }

        if (!isUsdcToken && isMiningCenterFraction) {
          console.error(
            "[FractionEventService] Non-USDC token used for mining-center fraction:",
            event.payload.fractionId,
            "Token:",
            event.payload.token,
            "Expected USDC:",
            forwarderAddresses.USDC
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
          this.logExpected(
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
        if (event.environment !== environment) {
          return;
        }
        this.markEventReceived("fraction.closed", event.payload.fractionId);
        console.log(
          "[FractionEventService] Received fraction.closed event:",
          event.payload.fractionId
        );

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
          this.logExpected(
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
          this.logExpected(
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

    // Listen for fraction.refunded events
    this.listener.onEvent("fraction.refunded", "v2-alpha", async (event) => {
      try {
        if (event.environment !== environment) {
          return;
        }
        this.markEventReceived("fraction.refunded", event.payload.fractionId);
        console.log(
          "[FractionEventService] Received fraction.refunded event:",
          event.payload.fractionId,
          "for user:",
          event.payload.user
        );

        // Check if we already processed this refund event (idempotency)
        const existingRefund = await findFractionRefundByTxHash(
          event.payload.transactionHash,
          event.payload.logIndex
        );

        if (existingRefund) {
          this.logExpected(
            "[FractionEventService] Refund already processed, skipping:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          return;
        }

        // Record the fraction refund
        await recordFractionRefund({
          fractionId: event.payload.fractionId,
          transactionHash: event.payload.transactionHash,
          blockNumber: event.payload.blockNumber,
          logIndex: event.payload.logIndex,
          creator: event.payload.creator,
          user: event.payload.user,
          refundTo: event.payload.refundTo,
          amount: event.payload.amount,
          timestamp: event.payload.timestamp,
        });

        console.log(
          "[FractionEventService] Successfully recorded fraction refund for user:",
          event.payload.user,
          "on fraction:",
          event.payload.fractionId
        );
      } catch (error: any) {
        // Check if this is a duplicate key error
        if (
          error.code === "23505" ||
          error.message?.includes("duplicate key") ||
          error.message?.includes("already recorded")
        ) {
          this.logExpected(
            "[FractionEventService] Duplicate refund detected (likely due to concurrent processing), ignoring:",
            event.payload.transactionHash,
            event.payload.logIndex
          );
          // This is not a real error - the refund was already recorded
          return;
        }

        console.error(
          "[FractionEventService] Error processing fraction.refunded event:",
          error
        );

        // Only record as failed operation if it's not a duplicate key error
        try {
          await recordFailedFractionOperation({
            fractionId: event.payload.fractionId,
            operationType: "refund",
            eventType: "fraction.refunded",
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

    try {
      await this.listener.start();
      this.isListening = true;
      this.listenerStartedAtMs = Date.now();
      this.clearListenerError();
      console.log("[FractionEventService] Event listener started");
    } catch (error) {
      this.markListenerError("listener.start", error);
      throw error;
    }
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

  setListenerError(error: unknown, context = "listener"): void {
    this.markListenerError(context, error);
  }

  getHealthSnapshot(): FractionEventServiceHealth {
    return {
      isListening: this.isListening,
      listenerStartedAt: this.toIsoTimestamp(this.listenerStartedAtMs),
      lastEventAt: this.toIsoTimestamp(this.lastEventAtMs),
      lastEventType: this.lastEventType,
      lastEventFractionId: this.lastEventFractionId,
      listenerError: this.listenerError,
      listenerErrorAt: this.toIsoTimestamp(this.listenerErrorAtMs),
    };
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
