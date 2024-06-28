import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications } from "../../schema";

export const findFirstOrganizationApplicationByApplicationId = async (
  applicationId: string
) => {
  const applicationDb = await db.query.OrganizationApplications.findFirst({
    where: eq(OrganizationApplications.applicationId, applicationId),
    columns: {},
    with: {
      organization: true,
    },
  });
  return applicationDb;
};
