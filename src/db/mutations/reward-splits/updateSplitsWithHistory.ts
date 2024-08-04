import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  RewardSplitsInsertType,
  RewardSplits,
  RewardsSplitsHistory,
} from "../../schema";

export const updateSplitsWithHistory = async (
  applicationId: string,
  farmId: string,
  values: RewardSplitsInsertType[]
) => {
  await db.transaction(async (tx) => {
    const oldSplits = await tx.query.RewardSplits.findMany({
      where: eq(RewardSplits.applicationId, applicationId),
    });

    if (oldSplits.length === 0) {
      tx.rollback();
    }

    const insertHistoryRes = await tx.insert(RewardsSplitsHistory).values({
      applicationId,
      farmId,
      createdAt: new Date(),
      rewardsSplits: oldSplits.map((o) => ({
        walletAddress: o.walletAddress,
        usdgSplitPercent: o.usdgSplitPercent,
        glowSplitPercent: o.glowSplitPercent,
      })),
    });

    if (insertHistoryRes.length === 0) {
      tx.rollback();
    }

    const insertRes = await tx
      .insert(RewardSplits)
      .values(values)
      .returning({ id: RewardSplits.id });

    if (insertRes.length === 0) {
      tx.rollback();
    }
  });
};
