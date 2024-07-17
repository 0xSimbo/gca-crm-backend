import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  OrganizationApplications,
  OrganizationUsers,
} from "../../schema";
import { findAllOrgMembersWithDocumentsAccessWithoutOwner } from "../../queries/organizations/findAllOrgMembersWithDocumentsAccessWithoutOwner";

export const deleteOrganizationApplication = async (
  organizationId: string,
  applicationId: string,
  applicationOwnerId: string
) => {
  const orgMembersWithDocumentsAccessWithoutOwner =
    await findAllOrgMembersWithDocumentsAccessWithoutOwner(
      applicationOwnerId,
      organizationId
    );

  await db.transaction(async (tx) => {
    await tx
      .delete(OrganizationApplications)
      .where(
        and(
          eq(OrganizationApplications.organizationId, organizationId),
          eq(OrganizationApplications.applicationId, applicationId)
        )
      );
    if (orgMembersWithDocumentsAccessWithoutOwner.length > 0) {
      await tx.delete(ApplicationsEncryptedMasterKeys).where(
        and(
          eq(ApplicationsEncryptedMasterKeys.applicationId, applicationId),
          inArray(
            ApplicationsEncryptedMasterKeys.organizationUserId,
            orgMembersWithDocumentsAccessWithoutOwner.map((member) => member.id)
          )
        )
      );
    }
  });
};
