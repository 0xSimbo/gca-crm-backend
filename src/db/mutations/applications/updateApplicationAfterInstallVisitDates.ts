import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationAfterInstallVisitDates = async (
  applicationId: string,
  afterInstallVisitDateFrom: Date,
  afterInstallVisitDateTo: Date
) => {
  return await db
    .update(applications)
    .set({
      afterInstallVisitDateFrom: afterInstallVisitDateFrom,
      afterInstallVisitDateTo: afterInstallVisitDateTo,
      status: ApplicationStatusEnum.waitingForVisit,
    })
    .where(eq(applications.id, applicationId));
};
