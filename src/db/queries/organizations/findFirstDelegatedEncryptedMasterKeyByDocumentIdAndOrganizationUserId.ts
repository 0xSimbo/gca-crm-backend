import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { DelegatedDocumentsEncryptedMasterKeys } from "../../schema";

export const findFirstDelegatedEncryptedMasterKeyByDocumentIdAndOrganizationUserId =
  async (organizationUserIds: string[], documentId: string) => {
    const delegatedDocumentEncryptedMasterKey =
      await db.query.DelegatedDocumentsEncryptedMasterKeys.findMany({
        where: and(
          eq(DelegatedDocumentsEncryptedMasterKeys.documentId, documentId),
          inArray(
            DelegatedDocumentsEncryptedMasterKeys.organizationUserId,
            organizationUserIds
          )
        ),
      });
    return delegatedDocumentEncryptedMasterKey;
  };
