import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

export const viemClient = createPublicClient({
  transport: http(process.env.MAINNET_RPC_URL!),
  chain: mainnet,
});
