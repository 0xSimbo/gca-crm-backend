import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { RewardSplits } from "../../schema";

export const findAllRewardSplitsByApplicationId = async (
  applicationId: string
) => {
  const splitsDb = await db.query.RewardSplits.findMany({
    where: eq(RewardSplits.applicationId, applicationId),
    orderBy: asc(RewardSplits.id),
  });
  return splitsDb;
};
