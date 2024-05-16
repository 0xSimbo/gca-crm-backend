import { db } from "../../db";
import { ApplicationInsertType, applications } from "../../schema";

export const createApplication = async (application: ApplicationInsertType) => {
  const res = await db
    .insert(applications)
    .values(application)
    .returning({ insertedId: applications.id });
  if (res.length === 0) throw new Error("Failed to create application");
  const insertedId = res[0].insertedId;
  return insertedId;
};
