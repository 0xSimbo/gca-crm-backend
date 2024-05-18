import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const incrementApplicationStep = async (
  applicationId: string,
  index: number
) => {
  return await db
    .update(applications)
    .set({
      status: ApplicationStatusEnum.draft,
      currentStep: index + 1,
    })
    .where(eq(applications.id, applicationId));
};
