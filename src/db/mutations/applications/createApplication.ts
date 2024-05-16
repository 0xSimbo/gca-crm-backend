import { db } from "../../db";
import { ApplicationInsertType, applications } from "../../schema";

export const createApplication = async (application: ApplicationInsertType) => {
  const insertedId = await db
    .insert(applications)
    .values(application)
    .returning({ insertedId: applications.id });
  return { insertedId };
};
