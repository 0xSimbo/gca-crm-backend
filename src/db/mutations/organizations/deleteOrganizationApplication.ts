import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications } from "../../schema";

export const deleteOrganizationApplication = async (
  organizationId: string,
  applicationId: string
) => {
  await db
    .delete(OrganizationApplications)
    .where(
      and(
        eq(OrganizationApplications.organizationId, organizationId),
        eq(OrganizationApplications.applicationId, applicationId)
      )
    );
};
