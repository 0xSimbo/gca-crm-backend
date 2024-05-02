import { db } from "../../db/db";
import { sql } from "drizzle-orm";
import { getMerkleTreeForWeek } from "../../lib/get-merkletree-for-week";
import { getRewardsInBucket } from "../../lib/web3-view/get-rewards-in-bucket";
import { DB_DECIMALS, GLOW_REWARDS_PER_WEEK } from "../../constants";
import { formatUnits } from "viem";
import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";
import { ethers } from "ethers";
/**
    Each
*/
export const updateUserRewardsForWeek = async (weekNumber: number) => {
  //We need to get the tree for the (week - 1) since the data in report 21 is of week 20
  const { merkleTree } = await getMerkleTreeForWeek(weekNumber - 1);
  const leafType = ["address", "uint256", "uint256"];

  const leaves = merkleTree.map((leaf) => {
    const values = [leaf.address, leaf.glowWeight, leaf.usdcWeight];
    const hash = ethers.utils.solidityKeccak256(leafType, values);
    return hash;
  });
  const tree = new MerkleTree(leaves, keccak256, { sort: true });

  //TODO: Grab the on-chain rewards.
  // We can store this in a 24 hour since there is a 16 week offset between
  // Rewards being injected vs their distribution.
  // For example: If Week 20 of the protocol gets injected with $10,000 in USDG Rewards,
  // Those rewards are not available until Week 36.
  const usdgRewards = await getRewardsInBucket(weekNumber);

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
    },
  );

  const usersAndRewards = merkleTree.map((leaf) => {
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

    let targetLeaf = ethers.utils.solidityKeccak256(leafType, [
      leaf.address,
      leaf.glowWeight,
      leaf.usdcWeight,
    ]);

    const proof = tree.getHexProof(targetLeaf);

    return {
      address: leaf.address,
      glowWeight: leaf.glowWeight,
      usdgWeight: leaf.usdcWeight,
      usdgRewards: Math.floor(
        parseInt(formatUnits(usdgRewardsForLeaf, 6 - DB_DECIMALS)),
      ), //Even though USDC is 6 decimals,
      //In the database, we keep everything at 2 decimals, so instead of / 1e6 , we / by 1e4 to avoid extra calculations
      glowRewards: glowRewardsForLeaf * BigInt(10 ** DB_DECIMALS), //This is already in human readable format
      claimProof: proof,
    };
  });

  const INDEX = 0; //TODO: fix when u get a chance
  const globalValues = usersAndRewards
    .map((user) => {
      return `('${user.address}', ${user.usdgRewards.toString()}, ${user.glowRewards.toString()})`;
    })
    .join(", ");

  const weeklyScopedValues = usersAndRewards
    .map((user) => {
      const proof = `{${user.claimProof.map((p) => `"${p}"`).join(",")}}`; // Create a PostgreSQL array string
      return `('${user.address}', ${weekNumber}, ${user.usdgWeight}, ${user.glowWeight}, ${user.usdgRewards}, ${user.glowRewards.toString()}, ${INDEX}, '${proof}')`;
    })
    .join(", ");

  const sqlQuery =
    sql.raw(`INSERT into users (wallet, total_usdg_rewards, total_glow_rewards)
  VALUES ${globalValues}
  ON CONFLICT (wallet) DO UPDATE SET
  total_usdg_rewards = users.total_usdg_rewards + EXCLUDED.total_usdg_rewards,
  total_glow_rewards = users.total_glow_rewards + EXCLUDED.total_glow_rewards;

  INSERT into user_weekly_rewards (wallet, week_number, usdg_weight, glow_weight, usdg_rewards, glow_rewards, index_in_reports, claim_proof)
  VALUES ${weeklyScopedValues};
  `);

  await db.execute(sqlQuery);
};
