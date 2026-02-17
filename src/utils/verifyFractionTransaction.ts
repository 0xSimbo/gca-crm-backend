import { createPublicClient, decodeEventLog, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { OFFCHAIN_FRACTIONS_ABI } from "@glowlabs-org/utils/browser";
import type { Abi } from "viem";
import { forwarderAddresses } from "../constants/addresses";

const RETRYABLE_RPC_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const VERIFY_TX_RPC_TIMEOUT_MS = 20_000;
const VERIFY_TX_RPC_RETRY_COUNT = 2;
const VERIFY_TX_RPC_RETRY_DELAY_MS = 200;

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error == null) return null;

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;

  const causeStatus = (error as { cause?: { status?: unknown } }).cause?.status;
  if (typeof causeStatus === "number" && Number.isFinite(causeStatus))
    return causeStatus;

  return null;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryableRpcTransportError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status != null) return RETRYABLE_RPC_STATUS_CODES.has(status);

  const message = getErrorText(error).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function getFallbackRpcUrl(params: {
  primaryRpcUrl: string;
  isProduction: boolean;
}): string | null {
  const explicitFallback = process.env.MAINNET_RPC_FALLBACK_URL?.trim();
  if (
    params.isProduction &&
    isHttpUrl(explicitFallback) &&
    explicitFallback !== params.primaryRpcUrl
  ) {
    return explicitFallback;
  }

  const chainDefaultUrl = params.isProduction
    ? mainnet.rpcUrls.default.http[0]
    : sepolia.rpcUrls.default.http[0];

  if (!chainDefaultUrl || chainDefaultUrl === params.primaryRpcUrl) return null;
  return chainDefaultUrl;
}

/**
 * Verify fraction.sold event data against on-chain transaction logs
 */
export async function verifyFractionSoldTransaction(eventPayload: {
  fractionId: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: number;
  creator: string;
  buyer: string;
  step: string;
  amount: string;
}): Promise<{ isValid: boolean; error?: string }> {
  try {
    if (!process.env.MAINNET_RPC_URL) {
      throw new Error("MAINNET_RPC_URL is not set");
    }

    const isProduction = process.env.NODE_ENV === "production";
    const primaryRpcUrl =
      isProduction
        ? process.env.MAINNET_RPC_URL!
        : "https://ethereum-sepolia-rpc.publicnode.com";
    const chain = isProduction ? mainnet : sepolia;
    const client = createPublicClient({
      chain,
      transport: http(primaryRpcUrl, {
        timeout: VERIFY_TX_RPC_TIMEOUT_MS,
        retryCount: VERIFY_TX_RPC_RETRY_COUNT,
        retryDelay: VERIFY_TX_RPC_RETRY_DELAY_MS,
      }),
    });

    // Fetch the transaction receipt
    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
    try {
      receipt = await client.getTransactionReceipt({
        hash: eventPayload.transactionHash as `0x${string}`,
      });
    } catch (primaryError) {
      if (!isRetryableRpcTransportError(primaryError)) throw primaryError;

      const fallbackRpcUrl = getFallbackRpcUrl({
        primaryRpcUrl,
        isProduction,
      });
      if (!fallbackRpcUrl) throw primaryError;

      const fallbackClient = createPublicClient({
        chain,
        transport: http(fallbackRpcUrl, {
          timeout: VERIFY_TX_RPC_TIMEOUT_MS,
          retryCount: VERIFY_TX_RPC_RETRY_COUNT,
          retryDelay: VERIFY_TX_RPC_RETRY_DELAY_MS,
        }),
      });

      try {
        receipt = await fallbackClient.getTransactionReceipt({
          hash: eventPayload.transactionHash as `0x${string}`,
        });
      } catch (fallbackError) {
        throw new Error(
          `Failed to fetch transaction receipt from primary and fallback RPC providers. primary=${getErrorText(
            primaryError
          )}; fallback=${getErrorText(fallbackError)}`
        );
      }
    }

    if (!receipt) {
      return {
        isValid: false,
        error: `Transaction receipt not found for hash: ${eventPayload.transactionHash}`,
      };
    }

    // Find the FractionSold event log by searching through all logs (following getForwarderDataFromTxHashReceipt.ts pattern)
    const fractionContractAddress = forwarderAddresses.OFFCHAIN_FRACTIONS;

    const fractionSoldLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== fractionContractAddress.toLowerCase()) {
        return false;
      }
      try {
        const decoded = decodeEventLog({
          abi: OFFCHAIN_FRACTIONS_ABI as unknown as Abi,
          eventName: "FractionSold",
          data: log.data,
          topics: log.topics,
        });
        return decoded?.eventName === "FractionSold";
      } catch {
        return false;
      }
    });

    if (!fractionSoldLog) {
      return {
        isValid: false,
        error: `FractionSold event not found in transaction logs. Contract: ${fractionContractAddress}`,
      };
    }

    // Decode the FractionSold event
    type FractionSoldEventArgs = {
      id: string;
      creator: string;
      buyer: string;
      step: bigint;
      amount: bigint;
    };

    const decodedEvent = decodeEventLog({
      abi: OFFCHAIN_FRACTIONS_ABI as unknown as Abi,
      eventName: "FractionSold",
      data: fractionSoldLog.data,
      topics: fractionSoldLog.topics,
    }) as unknown as { eventName: "FractionSold"; args: FractionSoldEventArgs };

    // Verify the decoded event data matches the event payload
    const onChainData = {
      fractionId: decodedEvent.args.id,
      creator: decodedEvent.args.creator,
      buyer: decodedEvent.args.buyer,
      step: decodedEvent.args.step.toString(),
      amount: decodedEvent.args.amount.toString(),
    };

    // Compare each field
    if (
      onChainData.fractionId.toLowerCase() !==
      eventPayload.fractionId.toLowerCase()
    ) {
      return {
        isValid: false,
        error: `Fraction ID mismatch: event=${eventPayload.fractionId}, onchain=${onChainData.fractionId}`,
      };
    }

    if (
      onChainData.creator.toLowerCase() !== eventPayload.creator.toLowerCase()
    ) {
      return {
        isValid: false,
        error: `Creator mismatch: event=${eventPayload.creator}, onchain=${onChainData.creator}`,
      };
    }

    if (onChainData.buyer.toLowerCase() !== eventPayload.buyer.toLowerCase()) {
      return {
        isValid: false,
        error: `Buyer mismatch: event=${eventPayload.buyer}, onchain=${onChainData.buyer}`,
      };
    }

    if (onChainData.step !== eventPayload.step) {
      return {
        isValid: false,
        error: `Step mismatch: event=${eventPayload.step}, onchain=${onChainData.step}`,
      };
    }

    if (onChainData.amount !== eventPayload.amount) {
      return {
        isValid: false,
        error: `Amount mismatch: event=${eventPayload.amount}, onchain=${onChainData.amount}`,
      };
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Transaction verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
