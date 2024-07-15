import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { DelegatedDocumentsEncryptedMasterKeysByGca } from "../../schema";

export const findFirstDelegatedEncryptedMasterKeyByDocumentId = async (
  gcaDelegatedUserId: string,
  documentId: string
) => {
  const delegatedDocumentEncryptedMasterKey =
    await db.query.DelegatedDocumentsEncryptedMasterKeysByGca.findMany({
      where: and(
        eq(
          DelegatedDocumentsEncryptedMasterKeysByGca.gcaDelegatedUserId,
          gcaDelegatedUserId
        ),
        eq(DelegatedDocumentsEncryptedMasterKeysByGca.documentId, documentId)
      ),
    });
  return delegatedDocumentEncryptedMasterKey;
};
