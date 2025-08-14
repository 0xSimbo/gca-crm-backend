import {
  addresses,
  MinerPoolAndGCA__factory,
} from "@glowlabs-org/guarded-launch-ethers-sdk";
import { viemClient } from "../web3-providers/viem-client";

/**
 * @returns {BigInt} - the amount of USDG Rewards In A Bucket
            - has 6 decimals
 */
export const getRewardsInBucket = async (
  weekNumber: number
): Promise<BigInt> => {
  try {
    const rewards = (await viemClient.readContract({
      address: addresses.gcaAndMinerPoolContract as `0x${string}`,
      abi: MinerPoolAndGCA__factory.abi,
      functionName: "reward",
      args: [BigInt(weekNumber)],
    })) as { amountInBucket: BigInt };
    const amountInBucket = rewards.amountInBucket;
    return amountInBucket;
  } catch (e) {
    return BigInt(0);
  }
};
