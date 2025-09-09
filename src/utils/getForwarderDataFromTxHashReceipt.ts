import { addresses, forwarderAddresses } from "../constants/addresses";
import { FORWARDER_ABI, TRANSFER_TYPES } from "@glowlabs-org/utils/browser";
import { createPublicClient, decodeEventLog, http } from "viem";
import type { Abi } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { PaymentCurrency } from "@glowlabs-org/utils/browser";
// --------------------------------------------------
// Forwarder event utility
// --------------------------------------------------

export interface GetForwarderDataFromTxHashReceipt {
  /** Raw USDC amount (6-decimals) */
  amount: string;
  /** Application ID */
  message: string;
  /** Timestamp of the block that included the transaction */
  paymentDate: Date;
  /** Sender address */
  from: string;
  /** Recipient address (forward target) */
  to: string;
  /** Token address */
  token: string;
  /** Event type extracted from message */
  eventType: string;
  /** Application ID extracted from message */
  applicationId: string;
  /** Currency paid (GCTL or USDC) */
  paymentCurrency: PaymentCurrency;
}

/**
 * Parse message in format "EventType::ApplicationId" and extract components
 */
const parseForwardMessage = (
  message: string
): { eventType: string; applicationId: string } => {
  const parts = message.split("::");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid message format. Expected "EventType::ApplicationId", got: ${message}`
    );
  }
  return {
    eventType: parts[0],
    applicationId: parts[1],
  };
};

/**
 * Decode a transaction hash and return the data embedded in the `Forward`
 * event. Throws when the event is not found or the provider cannot fetch the
 * relevant information.
 */
export const getForwarderDataFromTxHashReceipt = async (
  txHash: string
): Promise<GetForwarderDataFromTxHashReceipt> => {
  if (!process.env.MAINNET_RPC_URL) {
    throw new Error("MAINNET_RPC_URL is not set");
  }

  const rpcUrl =
    process.env.NODE_ENV === "production"
      ? process.env.MAINNET_RPC_URL!
      : "https://ethereum-sepolia-rpc.publicnode.com";
  const chain = process.env.NODE_ENV === "production" ? mainnet : sepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  // Fetch the transaction receipt which contains the logs we are interested in.
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  if (!receipt) {
    throw new Error(`Transaction receipt not found for hash: ${txHash}`);
  }

  // Derive the block timestamp — this is not present on the receipt itself.
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!block) {
    throw new Error("Block details not found");
  }

  // Find the first log that successfully decodes to the `Forward` event from the expected contract
  const forwardLog = receipt.logs.find((log) => {
    if (
      log.address.toLowerCase() !== forwarderAddresses.FORWARDER.toLowerCase()
    ) {
      return false;
    }
    try {
      const decoded = decodeEventLog({
        abi: FORWARDER_ABI as unknown as Abi,
        eventName: "Forward",
        data: log.data,
        topics: log.topics,
      });
      return decoded?.eventName === "Forward";
    } catch {
      return false;
    }
  });

  if (!forwardLog) {
    throw new Error("Forward event not found in transaction logs");
  }

  type ForwardEventArgs = {
    amount: bigint;
    message: string;
    from: string;
    to: string;
    token: string;
  };
  const decodedUnknown = decodeEventLog({
    abi: FORWARDER_ABI as unknown as Abi,
    eventName: "Forward",
    data: forwardLog.data,
    topics: forwardLog.topics,
  }) as unknown as { eventName: "Forward"; args: ForwardEventArgs };

  const amount = decodedUnknown.args.amount.toString();
  const message = decodedUnknown.args.message;
  const from = decodedUnknown.args.from;
  const to = decodedUnknown.args.to;
  const token = decodedUnknown.args.token;

  // Normalize the address once to avoid repeated `toLowerCase` calls
  const normalizedToken = token.toLowerCase();

  // Map each supported token address to its corresponding currency symbol
  const tokenCurrencyMap: Record<string, PaymentCurrency> = {
    [addresses.usdg.toLowerCase()]: "USDG",
    [addresses.usdc.toLowerCase()]: "USDC",
    [addresses.glow.toLowerCase()]: "GLW",
  } as const;

  const paymentCurrency = tokenCurrencyMap[normalizedToken];

  if (!paymentCurrency) {
    throw new Error(`Invalid token: ${token}`);
  }

  const { eventType, applicationId } = parseForwardMessage(message);

  if (
    eventType !== TRANSFER_TYPES.PayProtocolFeeAndMintGCTLAndStake &&
    eventType !== TRANSFER_TYPES.PayProtocolFee &&
    eventType !== TRANSFER_TYPES.PayAuditFees
  ) {
    throw new Error(`Unsupported eventType: ${eventType}`);
  }

  // Valid currencies for every supported `eventType`
  const eventAllowedCurrencies: Record<string, PaymentCurrency[]> = {
    PayProtocolFee: ["USDG", "USDC", "GLW"],
    PayProtocolFeeAndMintGCTLAndStake: ["USDG", "USDC"],
    PayAuditFees: ["USDC"],
  } as const;

  const allowedCurrencies = eventAllowedCurrencies[eventType];

  if (!allowedCurrencies) {
    throw new Error(`Unsupported eventType: ${eventType}`);
  }

  if (!allowedCurrencies.includes(paymentCurrency)) {
    throw new Error(
      `Currency ${paymentCurrency} not allowed for eventType ${eventType}`
    );
  }

  return {
    amount,
    message,
    paymentDate: new Date(Number(block.timestamp) * 1000),
    from,
    to,
    token,
    eventType,
    applicationId,
    paymentCurrency,
  };
};
