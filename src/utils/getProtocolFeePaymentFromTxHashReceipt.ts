import { createPublicClient, http } from "viem";
import { mainnet, sepolia } from "viem/chains";

export type GetProtocolFeePaymentFromTxHashReceipt = {
  amount: string;
  paymentDate: Date;
  user: {
    id: string;
  };
};

export const getProtocolFeePaymentFromTxHashReceipt = async (
  txHash: string
): Promise<GetProtocolFeePaymentFromTxHashReceipt> => {
  if (!process.env.MAINNET_RPC_URL) {
    throw new Error("MAINNET_RPC_URL is not set");
  }

  const chain = process.env.NODE_ENV === "production" ? mainnet : sepolia;
  const client = createPublicClient({
    chain,
    transport: http(process.env.MAINNET_RPC_URL),
  });

  const txHashInfo = await client.getTransaction({
    hash: txHash as `0x${string}`,
  });

  if (!txHashInfo) {
    throw new Error("Transaction not found");
  }

  if (txHashInfo.blockNumber == null) {
    throw new Error("Block Number not found");
  }

  const block = await client.getBlock({ blockNumber: txHashInfo.blockNumber });

  if (!block) {
    throw new Error("Block not found");
  }

  // Extract timestamp from block details
  const timestamp = Number(block.timestamp);

  // Convert timestamp to a readable date
  const date = new Date(timestamp * 1000);
  const data = txHashInfo.input;
  const valueUSDC = "0x" + data.slice(10, 74);
  console.log("valueUSDC", valueUSDC);
  const bnUSDC = BigInt(valueUSDC);

  return {
    amount: bnUSDC.toString(),
    paymentDate: date,
    user: {
      id: txHashInfo.from,
    },
  };
};
