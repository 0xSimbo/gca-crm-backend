import { eq } from "drizzle-orm";
import { db } from "../../db";
import { DelegatedDocumentsEncryptedMasterKeys } from "../../schema";

export const deleteAllOrganizationMemberEncryptedDocumentsMasterKeys = async (
  organizationUserId: string
) => {
  return await db
    .delete(DelegatedDocumentsEncryptedMasterKeys)
    .where(
      eq(
        DelegatedDocumentsEncryptedMasterKeys.organizationUserId,
        organizationUserId
      )
    );
};
