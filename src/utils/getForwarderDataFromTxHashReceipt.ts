import { addresses } from "@glowlabs-org/guarded-launch-ethers-sdk";
import { ethers } from "ethers";
// --------------------------------------------------
// Forwarder event utility
// --------------------------------------------------

// The `Forward` event emitted by the on-chain forwarder contract.
export const forwarderABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "string",
        name: "message",
        type: "string",
      },
    ],
    name: "Forward",
    type: "event",
  },
] as const;

export type PaymentCurrency = "GCTL" | "USDC" | "USDG" | `0x${string}`;

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

  const USDC_ADDRESS_MAINNET =
    "0xa0b86991c6218b36b1d19d4a2e9eb0ce3606eb48" as `0x${string}`;
  const USDC_ADDRESS_SEPOLIA =
    "0x93c898be98cd2618ba84a6dccf5003d3bbe40356" as `0x${string}`;
  const USDC_ADDRESS =
    process.env.NODE_ENV === "production"
      ? USDC_ADDRESS_MAINNET
      : USDC_ADDRESS_SEPOLIA;

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
    forwarderABI as unknown as ethers.utils.Fragment[]
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

  const parsed = iface.parseLog(forwardLog);

  const amount = (parsed.args["amount"] as ethers.BigNumber).toString();
  const message = parsed.args["message"] as string;
  const from = parsed.args["from"] as string;
  const to = parsed.args["to"] as string;
  const token = parsed.args["token"] as string;

  if (token !== addresses.usdg && token !== USDC_ADDRESS) {
    throw new Error(`Invalid token: ${token}`);
  }

  const { eventType, applicationId } = parseForwardMessage(message);

  // Map eventType to currency; validate allowed events
  const paymentCurrencyMap: Record<string, PaymentCurrency> = {
    PayProtocolFee: "GCTL",
    PayProtocolFeeAndMintAndStake:
      token === addresses.usdg
        ? "USDG"
        : token === USDC_ADDRESS
        ? "USDC"
        : token,
  };

  const paymentCurrency = paymentCurrencyMap[eventType];

  if (!paymentCurrency) {
    throw new Error(
      `Unsupported eventType for protocol fee payment: ${eventType}`
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
