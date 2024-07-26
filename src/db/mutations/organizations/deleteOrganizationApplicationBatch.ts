import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, OrganizationUsers } from "../../schema";

export const deleteOrganizationApplicationBatch = async (
  applicationOwnerOrgUserId: string,
  organizationId: string,
  applicationIds: string[]
) => {
  await db.transaction(async (tx) => {
    if (applicationIds.length) {
      await tx
        .delete(OrganizationApplications)
        .where(
          and(
            eq(OrganizationApplications.organizationId, organizationId),
            inArray(OrganizationApplications.applicationId, applicationIds)
          )
        );
    }

    await tx
      .update(OrganizationUsers)
      .set({
        shareAllApplications: false,
      })
      .where(eq(OrganizationUsers.id, applicationOwnerOrgUserId));
  });
};
