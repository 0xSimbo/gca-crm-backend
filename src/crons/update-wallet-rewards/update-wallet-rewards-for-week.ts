import { db } from "../../db/db";
import { sql, eq } from "drizzle-orm";
import { getMerkleTreeForWeek } from "../../lib/get-merkletree-for-week";
import { getRewardsInBucket } from "../../lib/web3-view/get-rewards-in-bucket";
import { DB_DECIMALS, GLOW_REWARDS_PER_WEEK } from "../../constants";
import { checksumAddress, formatUnits } from "viem";
import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";

import { walletWeeklyRewards } from "../../db/schema";
import { solidityPackedKeccak256 } from "ethers";
/**
    Each
*/
export const updateWalletRewardsForWeek = async (
  weekNumber: number
): Promise<{ keepGoing: boolean }> => {
  //We need to get the tree for the (week - 1) since the data in report 21 is of week 20
  //Find first in db for
  const existsInCurrentWeek = await db
    .select()
    .from(walletWeeklyRewards)
    .where(eq(walletWeeklyRewards.weekNumber, weekNumber))
    .limit(1);
  if (existsInCurrentWeek.length > 0) {
    return { keepGoing: false };
  }

  //TODO: Grab the on-chain rewards.
  // We can store this in a 24 hour since there is a 16 week offset between
  // Rewards being injected vs their distribution.
  // For example: If Week 20 of the protocol gets injected with $10,000 in USDG Rewards,
  // Those rewards are not available until Week 36.
  const usdgRewards = await getRewardsInBucket(weekNumber);

  const { merkleTree } = await getMerkleTreeForWeek(weekNumber - 1);
  const leafType = ["address", "uint256", "uint256"];

  const leaves = merkleTree.map((leaf) => {
    const values = [leaf.address, leaf.glowWeight, leaf.usdcWeight];
    const hash = solidityPackedKeccak256(leafType, values);
    return hash;
  });
  const tree = new MerkleTree(leaves, keccak256, { sort: true });

  const sumOfWeights = merkleTree.reduce(
    (acc, cur) => {
      const newVal = {
        glowWeight: acc.glowWeight + BigInt(cur.glowWeight),
        usdgWeight: acc.usdgWeight + BigInt(cur.usdcWeight),
      };
      return newVal;
    },
    {
      glowWeight: BigInt(0),
      usdgWeight: BigInt(0),
    }
  );

  const walletsAndRewards = merkleTree.map((leaf) => {
    const glowRewardsForLeaf =
      sumOfWeights.glowWeight == BigInt(0)
        ? BigInt(0)
        : (BigInt(leaf.glowWeight) * BigInt(GLOW_REWARDS_PER_WEEK)) /
          sumOfWeights.glowWeight;
    const usdgRewardsForLeaf =
      sumOfWeights.usdgWeight == BigInt(0)
        ? BigInt(0)
        : (BigInt(leaf.usdcWeight) * BigInt(usdgRewards.toString())) /
          sumOfWeights.usdgWeight;

    let targetLeaf = solidityPackedKeccak256(leafType, [
      leaf.address,
      leaf.glowWeight,
      leaf.usdcWeight,
    ]);

    const proof = tree.getHexProof(targetLeaf);
    const checksummed = checksumAddress(leaf.address as `0x${string}`);
    return {
      address: checksummed,
      glowWeight: leaf.glowWeight,
      usdgWeight: leaf.usdcWeight,
      usdgRewards: Math.floor(
        parseInt(formatUnits(usdgRewardsForLeaf, 6 - DB_DECIMALS))
      ), //Even though USDC is 6 decimals,
      //In the database, we keep everything at 2 decimals, so instead of / 1e6 , we / by 1e4 to avoid extra calculations
      glowRewards: glowRewardsForLeaf * BigInt(10 ** DB_DECIMALS), //This is already in human readable format
      claimProof: proof,
    };
  });

  const totalGlowRewards = walletsAndRewards.reduce(
    (acc, cur) => acc + cur.glowRewards,
    BigInt(0)
  );
  const totalUsdgRewards = walletsAndRewards.reduce(
    (acc, cur) => acc + cur.usdgRewards,
    0
  );

  if (totalGlowRewards / BigInt(10 ** DB_DECIMALS) > GLOW_REWARDS_PER_WEEK) {
    throw new Error(
      `Total Glow Rewards ${totalGlowRewards} does not match expected ${GLOW_REWARDS_PER_WEEK}`
    );
  }

  if (
    totalUsdgRewards >
    parseFloat(formatUnits(usdgRewards as bigint, 6 - DB_DECIMALS))
  ) {
    throw new Error(
      `Total USDG Rewards ${totalUsdgRewards} does not match expected ${usdgRewards}`
    );
  }

  const INDEX = 0; //TODO: fix when u get a chance @0xSimbo don't forget to fix this
  const globalValues = walletsAndRewards
    .map((wallet) => {
      return `('${
        wallet.address
      }', ${wallet.usdgRewards.toString()}, ${wallet.glowRewards.toString()})`;
    })
    .join(", ");

  const weeklyScopedValues = walletsAndRewards
    .map((wallet) => {
      const proof = `{${wallet.claimProof.map((p) => `"${p}"`).join(",")}}`; // Create a PostgreSQL array string
      return `('${wallet.address}', ${weekNumber}, ${wallet.usdgWeight}, ${
        wallet.glowWeight
      }, ${
        wallet.usdgRewards
      }, ${wallet.glowRewards.toString()}, ${INDEX}, '${proof}')`;
    })
    .join(", ");

  const sqlQuery =
    sql.raw(`INSERT into wallets (wallet_id, total_usdg_rewards, total_glow_rewards)
  VALUES ${globalValues}
  ON CONFLICT (wallet_id) DO UPDATE SET
  total_usdg_rewards = wallets.total_usdg_rewards + EXCLUDED.total_usdg_rewards,
  total_glow_rewards = wallets.total_glow_rewards + EXCLUDED.total_glow_rewards;

  INSERT into wallet_weekly_rewards (wallet_id, week_number, usdg_weight, glow_weight, usdg_rewards, glow_rewards, index_in_reports, claim_proof)
  VALUES ${weeklyScopedValues};
  `);

  await db.execute(sqlQuery);
  return { keepGoing: true };
};
