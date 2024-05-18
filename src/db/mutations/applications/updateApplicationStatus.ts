import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications, users } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const updateApplicationStatus = async (
  applicationId: string,
  status: ApplicationStatusEnum
) => {
  return await db
    .update(applications)
    .set({
      status: status,
    })
    .where(eq(applications.id, applicationId));
};
