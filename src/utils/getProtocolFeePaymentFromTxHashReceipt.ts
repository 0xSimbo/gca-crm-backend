import { ethers } from "ethers";
import { formatUnits } from "ethers/lib/utils";

export type GetProtocolFeePaymentFromTxHashReceipt = {
  amount: string;
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
  const data = txHashInfo.data;
  const valueUSDC = "0x" + data.slice(10, 74);
  console.log("valueUSDC", valueUSDC);
  const bnUSDC = ethers.BigNumber.from(valueUSDC);

  return {
    amount: bnUSDC.toString(),
    user: {
      id: txHashInfo.from,
    },
  };
};
