import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents, documentsUpdates } from "../../schema";
import { EncryptedMasterKeySet } from "../../../types/api-types/Application";

export const updateDocumentKeysSets = async (
  gcaId: string,
  documentsUpdateObjects: {
    keysSets: EncryptedMasterKeySet[];
    documentId: string;
  }[]
) => {
  return await db.transaction(async (trx) => {
    for (const { keysSets, documentId } of documentsUpdateObjects) {
      const documentUpdate = await trx
        .update(Documents)
        .set({
          encryptedMasterKeys: keysSets,
          updatedAt: new Date(),
        })
        .where(eq(Documents.id, documentId))
        .returning({ id: Documents.id });

      if (documentUpdate.length !== 1) {
        trx.rollback();
      }

      const insertDocumentUpdateHistory = await trx
        .insert(documentsUpdates)
        .values({
          documentId: documentId,
          updatedBy: gcaId,
          createdAt: new Date(),
        })
        .returning({ id: documentsUpdates.id });

      if (insertDocumentUpdateHistory.length !== 1) {
        trx.rollback();
      }
    }
  });
};
