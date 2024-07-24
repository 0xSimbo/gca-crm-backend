import { ethers } from "ethers";
import { formatUnits } from "ethers/lib/utils";

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
  const provider = new ethers.providers.StaticJsonRpcProvider({
    url: process.env.MAINNET_RPC_URL!!,
    skipFetchSetup: true,
  });

  const txHashInfo = await provider.getTransaction(txHash);

  if (!txHashInfo.blockNumber) {
    throw new Error("Block Number not found");
  }

  const block = await provider.getBlock(txHashInfo.blockNumber);

  if (!block) {
    throw new Error("Block not found");
  }

  // Extract timestamp from block details
  const timestamp = block.timestamp;

  // Convert timestamp to a readable date
  const date = new Date(timestamp * 1000);
  const data = txHashInfo.data;
  const valueUSDC = "0x" + data.slice(10, 74);
  console.log("valueUSDC", valueUSDC);
  const bnUSDC = ethers.BigNumber.from(valueUSDC);

  return {
    amount: bnUSDC.toString(),
    paymentDate: date,
    user: {
      id: txHashInfo.from,
    },
  };
};
