import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationAfterInstallVisitDate = async (
  applicationId: string,
  afterInstallVisitDate: Date
) => {
  return await db
    .update(applications)
    .set({
      afterInstallVisitDate: afterInstallVisitDate,
      status: ApplicationStatusEnum.waitingForVisit,
    })
    .where(eq(applications.id, applicationId));
};
