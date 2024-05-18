import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationUpdateEnquiryType, applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationEnquiry = async (
  applicationId: string,
  insertValues: ApplicationUpdateEnquiryType
) => {
  return await db
    .update(applications)
    .set({
      ...insertValues,
      status: ApplicationStatusEnum.waitingForApproval,
    })
    .where(eq(applications.id, applicationId));
};
