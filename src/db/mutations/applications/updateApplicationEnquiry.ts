import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationUpdateEnquiryType, applications } from "../../schema";

export const updateApplicationEnquiry = async (
  applicationId: string,
  insertValues: ApplicationUpdateEnquiryType
) => {
  return await db
    .update(applications)
    .set(insertValues)
    .where(eq(applications.id, applicationId));
};
