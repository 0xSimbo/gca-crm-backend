import { db } from "../../db";
import { ApplicationInsertType, applications } from "../../schema";

export const createApplication = async (application: ApplicationInsertType) => {
  await db.insert(applications).values(application);
  return application;
};
