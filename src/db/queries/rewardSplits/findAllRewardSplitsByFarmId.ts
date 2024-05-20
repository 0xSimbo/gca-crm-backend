import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { RewardSplits } from "../../schema";

export const findAllRewardSplitsByUserFarmId = async (farmId: string) => {
  const splitsDb = await db.query.RewardSplits.findFirst({
    where: eq(RewardSplits.farmId, farmId),
    orderBy: asc(RewardSplits.id),
  });
  return splitsDb;
};
