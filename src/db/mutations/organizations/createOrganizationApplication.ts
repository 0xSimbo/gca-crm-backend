import { db } from "../../db";
import { OrganizationApplications } from "../../schema";

export const createOrganizationApplication = async (
  organizationId: string,
  applicationId: string
) => {
  const res = await db
    .insert(OrganizationApplications)
    .values({
      organizationId,
      applicationId,
    })
    .returning({ insertedId: OrganizationApplications.id });

  if (res.length === 0) {
    throw new Error("Failed to insert OrganizationApplication");
  }
};
