import { db } from "../../db";
import {
  DelegatedDocumentsEncryptedMasterKeysByGca,
  DelegatedDocumentsEncryptedMasterKeysByGcaInsertType,
} from "../../schema";

export const createEncryptedDocumentsMasterKeysByGca = async (
  delegatedDocumentsEncryptedMasterKeysByGca: DelegatedDocumentsEncryptedMasterKeysByGcaInsertType[]
) => {
  return await db
    .insert(DelegatedDocumentsEncryptedMasterKeysByGca)
    .values(delegatedDocumentsEncryptedMasterKeysByGca);
};
