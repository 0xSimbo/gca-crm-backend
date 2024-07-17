import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationsEncryptedMasterKeys } from "../../schema";

export const findFirstApplicationMasterKeyByApplicationIdAndUserId = async (
  userId: string,
  applicationId: string
) => {
  return await db.query.ApplicationsEncryptedMasterKeys.findFirst({
    where: and(
      eq(ApplicationsEncryptedMasterKeys.userId, userId),
      eq(ApplicationsEncryptedMasterKeys.applicationId, applicationId)
    ),
  });
};
