import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationPreInstallVisitDate = async (
  applicationId: string,
  preInstallVisitDate: Date
) => {
  return await db
    .update(applications)
    .set({
      preInstallVisitDate: preInstallVisitDate,
      status: ApplicationStatusEnum.waitingForVisit,
    })
    .where(eq(applications.id, applicationId));
};
