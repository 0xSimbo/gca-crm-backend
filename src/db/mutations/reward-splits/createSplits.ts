import { db } from "../../db";
import { RewardSplitsInsertType, RewardSplits } from "../../schema";

export const createSplits = async (values: RewardSplitsInsertType[]) => {
  const res = await db
    .insert(RewardSplits)
    .values(values)
    .returning({ id: RewardSplits.id });

  if (res.length === 0) {
    throw new Error("Failed to insert reward splits");
  }
};
