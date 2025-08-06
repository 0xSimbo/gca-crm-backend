import { ethers } from "ethers";
import { addresses, forwarderAddresses } from "../constants/addresses";
import { FORWARDER_ABI } from "@glowlabs-org/utils/browser";
// --------------------------------------------------
// Forwarder event utility
// --------------------------------------------------

export type PaymentCurrency = "GCTL" | "USDC" | "USDG" | "GLW";

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

  const provider = new ethers.providers.StaticJsonRpcProvider({
    url:
      process.env.NODE_ENV === "production"
        ? process.env.MAINNET_RPC_URL
        : "https://ethereum-sepolia-rpc.publicnode.com",
    skipFetchSetup: true,
  });

  // Fetch the transaction receipt which contains the logs we are interested in.
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`Transaction receipt not found for hash: ${txHash}`);
  }

  // Derive the block timestamp — this is not present on the receipt itself.
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) {
    throw new Error("Block details not found");
  }

  const iface = new ethers.utils.Interface(
    FORWARDER_ABI as unknown as ethers.utils.Fragment[]
  );

  // Find the first log that successfully decodes to the `Forward` event.
  const forwardLog = receipt.logs.find((log) => {
    try {
      const parsed = iface.parseLog(log);
      return parsed?.name === "Forward";
    } catch {
      return false;
    }
  });

  if (!forwardLog) {
    throw new Error("Forward event not found in transaction logs");
  }

  // Ensure the event was emitted by the expected forwarder contract
  if (
    forwardLog.address.toLowerCase() !==
    forwarderAddresses.FORWARDER.toLowerCase()
  ) {
    throw new Error(
      `Invalid forwarder contract: expected ${forwarderAddresses.FORWARDER}, got ${forwardLog.address}`
    );
  }

  const parsed = iface.parseLog(forwardLog);

  const amount = (parsed.args["amount"] as ethers.BigNumber).toString();
  const message = parsed.args["message"] as string;
  const from = parsed.args["from"] as string;
  const to = parsed.args["to"] as string;
  const token = parsed.args["token"] as string;

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
    eventType !== "PayProtocolFeeAndMintGCTLAndStake" &&
    eventType !== "PayProtocolFee"
  ) {
    throw new Error(`Unsupported eventType: ${eventType}`);
  }

  // Valid currencies for every supported `eventType`
  const eventAllowedCurrencies: Record<string, PaymentCurrency[]> = {
    PayProtocolFee: ["USDG", "USDC", "GLW"],
    PayProtocolFeeAndMintGCTLAndStake: ["USDG", "USDC"],
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
    paymentDate: new Date(block.timestamp * 1000),
    from,
    to,
    token,
    eventType,
    applicationId,
    paymentCurrency,
  };
};
