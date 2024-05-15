import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const FindFirstApplicationById = async (id: string) => {
  const application = await db.query.applications.findFirst({
    where: eq(applications.id, id),
    with: {
      gca: true,
      user: true,
      documentsMissingWithReason: true,
      annotations: true,
      installer: true,
    },
  });
  return application;
};
