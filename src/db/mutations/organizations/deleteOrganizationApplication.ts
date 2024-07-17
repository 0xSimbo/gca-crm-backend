import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  OrganizationApplications,
  OrganizationUsers,
} from "../../schema";

export const deleteOrganizationApplication = async (
  organizationId: string,
  applicationId: string,
  applicationOwnerId: string
) => {
  const orgMembersWithDocumentsAccess =
    await db.query.OrganizationUsers.findMany({
      where: and(
        eq(OrganizationUsers.organizationId, organizationId),
        eq(OrganizationUsers.hasDocumentsAccess, true)
      ),
      columns: {
        userId: true,
        id: true,
      },
    });

  await db.transaction(async (tx) => {
    await tx
      .delete(OrganizationApplications)
      .where(
        and(
          eq(OrganizationApplications.organizationId, organizationId),
          eq(OrganizationApplications.applicationId, applicationId)
        )
      );
    if (orgMembersWithDocumentsAccess.length > 0) {
      await tx.delete(ApplicationsEncryptedMasterKeys).where(
        and(
          eq(ApplicationsEncryptedMasterKeys.applicationId, applicationId),
          inArray(
            ApplicationsEncryptedMasterKeys.organizationUserId,
            orgMembersWithDocumentsAccess
              .filter((u) => u.userId !== applicationOwnerId)
              .map((member) => member.id)
          )
        )
      );
    }
  });
};
