import { parseAbi } from "viem";

import { viemClient } from "../../../lib/web3-providers/viem-client";
import { addresses } from "../../../constants/addresses";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

function getGlowTokenAddress(): `0x${string}` {
  const fromEnv = process.env.GLOW_TOKEN_ADDRESS;
  if (fromEnv && /^0x[a-fA-F0-9]{40}$/.test(fromEnv)) {
    return fromEnv as `0x${string}`;
  }
  return addresses.glow;
}

export async function getLiquidGlwBalanceWei(
  walletAddress: `0x${string}`
): Promise<bigint> {
  if (process.env.NODE_ENV === "production") {
    const glw = getGlowTokenAddress();
    return await viemClient.readContract({
      address: glw,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
  } else {
    return BigInt(0);
  }
}
