import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationInsertType, applications } from "../../schema";

export const updateApplication = async (
  applicationId: string,
  fields: Partial<ApplicationInsertType>
) => {
  return await db
    .update(applications)
    .set({
      ...fields,
    })
    .where(eq(applications.id, applicationId));
};
