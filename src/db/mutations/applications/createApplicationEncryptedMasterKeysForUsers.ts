import { db } from "../../db";
import {
  ApplicationsEncryptedMasterKeys,
  ApplicationsEncryptedMasterKeysInsertType,
} from "../../schema";

export const createApplicationEncryptedMasterKeysForUsers = async (
  applicationsEncryptedMasterKeysInsert: ApplicationsEncryptedMasterKeysInsertType[]
) => {
  if (applicationsEncryptedMasterKeysInsert.length === 0) {
    throw new Error("No applications encrypted master keys provided.");
  }
  await db
    .insert(ApplicationsEncryptedMasterKeys)
    .values(applicationsEncryptedMasterKeysInsert);
};
