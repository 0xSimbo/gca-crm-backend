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
}

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

  return {
    amount,
    message,
    paymentDate: new Date(block.timestamp * 1000),
    from,
    to,
  };
};
