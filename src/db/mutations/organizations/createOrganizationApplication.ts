import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  ApplicationsEncryptedMasterKeysInsertType,
  OrganizationApplications,
} from "../../schema";
import { deleteOrganizationApplication } from "./deleteOrganizationApplication";

export const createOrganizationApplication = async (
  applicationOwnerOrgUserId: string, // this is not user.userId, it is orgUser.id
  organizationId: string,
  applicationId: string,
  applicationsEncryptedMasterKeysInsert: ApplicationsEncryptedMasterKeysInsertType[],
  applicationOwnerId: string
) => {
  await db.transaction(async (tx) => {
    await deleteOrganizationApplication(
      organizationId,
      applicationId,
      applicationOwnerId
    );

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
