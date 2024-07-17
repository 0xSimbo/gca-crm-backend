import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  ApplicationsEncryptedMasterKeysInsertType,
  OrganizationApplications,
} from "../../schema";
import { findAllOrgMembersWithDocumentsAccessWithoutOwner } from "../../queries/organizations/findAllOrgMembersWithDocumentsAccessWithoutOwner";

export const createOrganizationApplication = async (
  applicationOwnerOrgUserId: string, // this is not user.userId, it is orgUser.id
  organizationId: string,
  applicationId: string,
  applicationsEncryptedMasterKeysInsert: ApplicationsEncryptedMasterKeysInsertType[],
  applicationOwnerId: string
) => {
  //TODO: finish impl here
  const orgMembersWithDocumentsAccessWithoutOwner =
    await findAllOrgMembersWithDocumentsAccessWithoutOwner(
      applicationOwnerId,
      organizationId
    );
  await db.transaction(async (tx) => {
    await tx
      .delete(OrganizationApplications)
      .where(and(eq(OrganizationApplications.applicationId, applicationId)));

    const res = await tx
      .insert(OrganizationApplications)
      .values({
        organizationId,
        applicationId,
        orgUserId: applicationOwnerOrgUserId,
      })
      .returning({ insertedId: OrganizationApplications.id });

    if (res.length === 0) {
      tx.rollback();
    }
    if (applicationsEncryptedMasterKeysInsert.length > 0) {
      const applicationsEncryptedMasterKeysInsertRes = await db
        .insert(ApplicationsEncryptedMasterKeys)
        .values(applicationsEncryptedMasterKeysInsert)
        .returning({ id: ApplicationsEncryptedMasterKeys.id });

      if (
        applicationsEncryptedMasterKeysInsertRes.length !==
        applicationsEncryptedMasterKeysInsert.length
      ) {
        tx.rollback();
      }
    }
  });
};
