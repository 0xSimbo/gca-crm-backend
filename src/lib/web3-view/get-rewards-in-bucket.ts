import { addresses } from "@glowlabs-org/guarded-launch-ethers-sdk";
import { viemClient } from "../web3-providers/viem-client";
import { ethersProvider } from "../web3-providers/ethers-provider";
import { minerPoolAndGCAAbi } from "@/abis/MinerPoolAndGCA.abi";
/**
 * @returns {BigInt} - the amount of USDG Rewards In A Bucket
            - has 6 decimals
 */
export const getRewardsInBucket = async (
  weekNumber: number,
): Promise<BigInt> => {
  //TODO: viem or ethers and grab it on-chain

  //If week < 20 return 0
  if (weekNumber < 20) {
    return BigInt(0);
  }

  try {
    const rewards = (await viemClient.readContract({
      address: addresses.gcaAndMinerPoolContract as `0x${string}`,
      abi: minerPoolAndGCAAbi,
      functionName: "reward",
      args: [BigInt(weekNumber)],
    })) as { amountInBucket: BigInt };
    return rewards.amountInBucket;
  } catch (e) {
    return BigInt(0);
  }
};
