import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const FindFirstApplicationById = async (id: string) => {
  const application = await db.query.applications.findFirst({
    where: eq(applications.id, id),
    with: {
      gca: true,
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          contactType: true,
          contactValue: true,
        },
      },
      documentsMissingWithReason: true,
      applicationStepApprovals: true,
      rewardSplits: true,
    },
  });
  return application;
};
