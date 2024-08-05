import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  RewardSplitsInsertType,
  RewardSplits,
  RewardsSplitsHistory,
} from "../../schema";

export const updateSplitsWithHistory = async (
  userId: string,
  applicationId: string,
  farmId: string,
  values: RewardSplitsInsertType[]
) => {
  await db.transaction(async (tx) => {
    const oldSplits = await tx.query.RewardSplits.findMany({
      where: eq(RewardSplits.applicationId, applicationId),
    });
    console.log("oldSplits", oldSplits);
    if (oldSplits.length === 0) {
      tx.rollback();
    }

    const insertHistoryRes = await tx
      .insert(RewardsSplitsHistory)
      .values({
        overWrittenBy: userId,
        applicationId,
        farmId,
        createdAt: new Date(),
        rewardsSplits: oldSplits.map((o) => ({
          walletAddress: o.walletAddress,
          usdgSplitPercent: o.usdgSplitPercent,
          glowSplitPercent: o.glowSplitPercent,
        })),
      })
      .returning({ id: RewardsSplitsHistory.id });

    if (insertHistoryRes.length === 0) {
      tx.rollback();
    }

    await tx
      .delete(RewardSplits)
      .where(eq(RewardSplits.applicationId, applicationId));

    const insertRes = await tx
      .insert(RewardSplits)
      .values(values)
      .returning({ id: RewardSplits.id });

    if (insertRes.length === 0) {
      tx.rollback();
    }
  });
};
