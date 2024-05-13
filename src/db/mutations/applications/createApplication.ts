import { db } from "../../db";
import { ApplicationInsertType, Applications } from "../../schema";

export const createApplication = async (application: ApplicationInsertType) => {
  await db.insert(Applications).values(application);
  return application;
};
