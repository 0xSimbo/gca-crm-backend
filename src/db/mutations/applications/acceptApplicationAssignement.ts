import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { RoundRobinStatusEnum } from "../../../types/api-types/Application";

export const acceptApplicationAssignement = async (
  applicationId: string,
  gcaAddress: string
) => {
  return await db
    .update(applications)
    .set({
      roundRobinStatus: RoundRobinStatusEnum.assigned,
      gcaAcceptanceTimestamp: new Date(),
      gcaAddress: gcaAddress,
    })
    .where(and(eq(applications.id, applicationId)));
};
