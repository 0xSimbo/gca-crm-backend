import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const findAllApplicationsRewardSplitsByUserId = async (
  userId: string,
  excludeIds?: string[]
) => {
  if (excludeIds && excludeIds.length === 0) {
    return await db.query.applications.findMany({
      where: and(
        eq(applications.userId, userId),
        notInArray(applications.id, excludeIds),
        ne(applications.isCancelled, true),
        eq(applications.status, ApplicationStatusEnum.completed)
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
      where: and(
        eq(applications.userId, userId),
        ne(applications.isCancelled, true),
        eq(applications.status, ApplicationStatusEnum.completed)
      ),
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
