import { JsonRpcProvider } from "ethers";

export const ethersProvider = new JsonRpcProvider(process.env.MAINNET_RPC_URL!);
