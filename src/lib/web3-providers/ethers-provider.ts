import { ethers } from "ethers";

export const ethersProvider = new ethers.providers.StaticJsonRpcProvider({
  url: process.env.MAINNET_RPC_URL!,
  skipFetchSetup: true,
});
