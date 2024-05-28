import { and, eq, not, notLike, sql } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const getUserPendingApplicationsCount = async (userId: string) => {
  const applicationsCount = await db
    .select({
      count: sql`count(*)`.mapWith(Number),
    })
    .from(applications)
    .where(
      and(
        eq(applications.userId, userId),
        not(eq(applications.status, ApplicationStatusEnum.completed)),
        not(eq(applications.status, ApplicationStatusEnum.quoteRejected))
      )
    )
    .groupBy(applications.id);
  return applicationsCount.reduce((acc, { count }) => acc + count, 0);
};
