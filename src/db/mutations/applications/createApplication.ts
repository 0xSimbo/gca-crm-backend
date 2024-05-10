import { db } from "../../db";
import { Applications, ApplicationType } from "../../schema";

export const createApplication = async (
  application: Omit<ApplicationType, "id">
) => {
  await db.insert(Applications).values(application);
  return application;
};
