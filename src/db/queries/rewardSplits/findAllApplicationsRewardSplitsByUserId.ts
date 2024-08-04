import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsRewardSplitsByUserId = async (
  userId: string,
  excludeIds?: string[]
) => {
  if (excludeIds && excludeIds.length === 0) {
    return await db.query.applications.findMany({
      where: and(
        eq(applications.userId, userId),
        notInArray(applications.id, excludeIds)
      ),
      columns: {
        id: true,
        farmOwnerName: true,
      },
      with: {
        rewardSplits: true,
      },
    });
  } else {
    return await db.query.applications.findMany({
      where: eq(applications.userId, userId),
      columns: {
        id: true,
        farmOwnerName: true,
      },
      with: {
        rewardSplits: true,
      },
    });
  }
};
