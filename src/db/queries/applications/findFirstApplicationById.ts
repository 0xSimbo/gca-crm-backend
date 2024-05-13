import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Applications } from "../../schema";

export const FindFirstApplicationById = async (id: string) => {
  const application = await db.query.Applications.findFirst({
    where: eq(Applications.id, id),
    with: {
      gca: true,
      farmOwner: true,
      documentsMissingWithReason: true,
    },
  });
  return application;
};
