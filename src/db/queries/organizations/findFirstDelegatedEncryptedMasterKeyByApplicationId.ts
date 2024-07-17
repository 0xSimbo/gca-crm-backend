import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationsEncryptedMasterKeys } from "../../schema";

export const findFirstDelegatedEncryptedMasterKeyByApplicationId = async (
  gcaDelegatedUserId: string,
  applicationId: string
) => {
  return await db.query.ApplicationsEncryptedMasterKeys.findFirst({
    where: and(
      eq(
        ApplicationsEncryptedMasterKeys.gcaDelegatedUserId,
        gcaDelegatedUserId
      ),
      eq(ApplicationsEncryptedMasterKeys.applicationId, applicationId)
    ),
  });
};
