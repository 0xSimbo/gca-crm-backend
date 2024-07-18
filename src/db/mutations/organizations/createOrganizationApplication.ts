import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  ApplicationsEncryptedMasterKeysInsertType,
  OrganizationApplications,
} from "../../schema";

export const createOrganizationApplication = async (
  applicationOwnerOrgUserId: string, // this is not user.userId, it is orgUser.id
  organizationId: string,
  applicationId: string,
  applicationsEncryptedMasterKeysInsert: ApplicationsEncryptedMasterKeysInsertType[]
) => {
  await db.transaction(async (tx) => {
    // if application is already shared with the organization, delete the existing shared application + all the encrypted master keys for the org members
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
  });
};
