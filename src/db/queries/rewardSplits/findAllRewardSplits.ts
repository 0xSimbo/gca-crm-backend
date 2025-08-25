import { db } from "../../db";

export const findAllRewardSplits = async () => {
  const rewardSplits = await db.query.RewardSplits.findMany();
  return rewardSplits;
};
