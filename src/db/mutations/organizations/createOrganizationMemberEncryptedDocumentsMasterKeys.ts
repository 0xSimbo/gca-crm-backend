import { db } from "../../db";
import {
  DelegatedDocumentsEncryptedMasterKeys,
  DelegatedDocumentsEncryptedMasterKeysInsertType,
} from "../../schema";

export const createOrganizationMemberEncryptedDocumentsMasterKeys = async (
  delegatedDocumentsEncryptedMasterKeys: DelegatedDocumentsEncryptedMasterKeysInsertType[]
) => {
  return await db
    .insert(DelegatedDocumentsEncryptedMasterKeys)
    .values(delegatedDocumentsEncryptedMasterKeys);
};
