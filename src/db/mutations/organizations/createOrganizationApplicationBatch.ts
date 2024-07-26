import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  ApplicationsEncryptedMasterKeysInsertType,
  OrganizationApplications,
  OrganizationUsers,
} from "../../schema";

export const createOrganizationApplicationBatch = async (
  applicationOwnerOrgUserId: string, // this is not user.userId, it is orgUser.id
  organizationId: string,
  applicationIds: string[],
  applicationsEncryptedMasterKeysInsert: ApplicationsEncryptedMasterKeysInsertType[]
) => {
  await db.transaction(async (tx) => {
    // if application is already shared with an organization, delete the existing shared application + all the encrypted master keys for the org members
    await tx
      .delete(OrganizationApplications)
      .where(inArray(OrganizationApplications.applicationId, applicationIds));

    const res = await tx
      .insert(OrganizationApplications)
      .values(
        applicationIds.map((applicationId) => ({
          organizationId,
          applicationId,
          orgUserId: applicationOwnerOrgUserId,
        }))
      )
      .returning({ insertedId: OrganizationApplications.id });

    if (res.length !== applicationIds.length) {
      tx.rollback();
    }

    if (applicationsEncryptedMasterKeysInsert.length > 0) {
      const applicationsEncryptedMasterKeysInsertRes = await tx
        .insert(ApplicationsEncryptedMasterKeys)
        .values(
          applicationsEncryptedMasterKeysInsert.map((item) => ({
            ...item,
            organizationApplicationId: res[0].insertedId,
          }))
        )
        .returning({ id: ApplicationsEncryptedMasterKeys.id });

      if (
        applicationsEncryptedMasterKeysInsertRes.length !==
        applicationsEncryptedMasterKeysInsert.length
      ) {
        tx.rollback();
      }
    }

    await tx
      .update(OrganizationUsers)
      .set({
        shareAllApplications: true,
      })
      .where(eq(OrganizationUsers.id, applicationOwnerOrgUserId));
  });
};
