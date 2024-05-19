import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationPreInstallVisitDates = async (
  applicationId: string,
  preInstallVisitDateFrom: Date,
  preInstallVisitDateTo: Date
) => {
  return await db
    .update(applications)
    .set({
      preInstallVisitDateFrom: preInstallVisitDateFrom,
      preInstallVisitDateTo: preInstallVisitDateTo,
      status: ApplicationStatusEnum.waitingForVisit,
    })
    .where(eq(applications.id, applicationId));
};
