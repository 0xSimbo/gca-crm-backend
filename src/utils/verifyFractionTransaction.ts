import { createPublicClient, decodeEventLog, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { OFFCHAIN_FRACTIONS_ABI } from "@glowlabs-org/utils/browser";
import type { Abi } from "viem";
import { forwarderAddresses } from "../constants/addresses";

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

    const rpcUrl =
      process.env.NODE_ENV === "production"
        ? process.env.MAINNET_RPC_URL!
        : "https://ethereum-sepolia-rpc.publicnode.com";
    const chain = process.env.NODE_ENV === "production" ? mainnet : sepolia;
    const client = createPublicClient({ chain, transport: http(rpcUrl) });

    // Fetch the transaction receipt
    const receipt = await client.getTransactionReceipt({
      hash: eventPayload.transactionHash as `0x${string}`,
    });

    if (!receipt) {
      return {
        isValid: false,
        error: `Transaction receipt not found for hash: ${eventPayload.transactionHash}`,
      };
    }

    // Find the FractionSold event log at the specified index
    const targetLog = receipt.logs[eventPayload.logIndex];
    if (!targetLog) {
      return {
        isValid: false,
        error: `Log not found at index ${eventPayload.logIndex}`,
      };
    }

    // Verify the log is from the correct contract
    const fractionContractAddress = forwarderAddresses.OFFCHAIN_FRACTIONS;
    if (
      targetLog.address.toLowerCase() !== fractionContractAddress.toLowerCase()
    ) {
      return {
        isValid: false,
        error: `Log address ${targetLog.address} does not match fraction contract ${fractionContractAddress}`,
      };
    }

    // Decode the FractionSold event
    let decodedEvent;
    try {
      decodedEvent = decodeEventLog({
        abi: OFFCHAIN_FRACTIONS_ABI as unknown as Abi,
        eventName: "FractionSold",
        data: targetLog.data,
        topics: targetLog.topics,
      }) as any;
    } catch (decodeError) {
      return {
        isValid: false,
        error: `Failed to decode FractionSold event: ${decodeError}`,
      };
    }

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
