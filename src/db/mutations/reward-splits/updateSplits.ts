import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  RewardSplitsInsertType,
  RewardSplits,
  applications,
} from "../../schema";

export const updateSplits = async (
  values: RewardSplitsInsertType[],
  applicationId: string
) => {
  await db.transaction(async (tx) => {
    const oldSplits = await tx.query.RewardSplits.findMany({
      where: eq(RewardSplits.applicationId, applicationId),
    });
    if (oldSplits.length > 0) {
      await tx
        .delete(RewardSplits)
        .where(eq(RewardSplits.applicationId, applicationId));
    }

    const res = await tx
      .insert(RewardSplits)
      .values(values)
      .returning({ id: RewardSplits.id });

    if (res.length === 0) {
      tx.rollback();
    }
  });
};
