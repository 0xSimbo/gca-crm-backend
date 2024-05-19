import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updatePreInstallVisitDateConfirmedTimestamp = async (
  applicationId: string
) => {
  return await db
    .update(applications)
    .set({
      preInstallVisitDateConfirmedTimestamp: new Date(),
      status: ApplicationStatusEnum.approved,
    })
    .where(eq(applications.id, applicationId));
};
