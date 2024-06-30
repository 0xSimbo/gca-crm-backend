import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  DelegatedDocumentsEncryptedMasterKeys,
  DelegatedDocumentsEncryptedMasterKeysInsertType,
  OrganizationApplications,
} from "../../schema";

export const createOrganizationApplication = async (
  applicationOwnerOrgUserId: string,
  organizationId: string,
  applicationId: string,
  delegatedDocumentsEncryptedMasterKeys: Omit<
    DelegatedDocumentsEncryptedMasterKeysInsertType,
    "organizationApplicationId"
  >[]
) => {
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
    if (delegatedDocumentsEncryptedMasterKeys.length > 0) {
      const insertKeysRes = await tx
        .insert(DelegatedDocumentsEncryptedMasterKeys)
        .values(
          delegatedDocumentsEncryptedMasterKeys.map((key) => ({
            ...key,
            organizationApplicationId: res[0].insertedId,
          }))
        )
        .returning({ insertedId: DelegatedDocumentsEncryptedMasterKeys.id });

      if (
        insertKeysRes.length !== delegatedDocumentsEncryptedMasterKeys.length
      ) {
        tx.rollback();
      }
    }
  });
};
