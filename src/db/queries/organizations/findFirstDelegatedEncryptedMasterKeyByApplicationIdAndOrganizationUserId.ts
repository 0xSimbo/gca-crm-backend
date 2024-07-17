import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationsEncryptedMasterKeys } from "../../schema";

export const findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId =
  async (organizationUserIds: string[], applicationId: string) => {
    return await db.query.ApplicationsEncryptedMasterKeys.findFirst({
      where: and(
        eq(ApplicationsEncryptedMasterKeys.applicationId, applicationId),
        inArray(
          ApplicationsEncryptedMasterKeys.organizationUserId,
          organizationUserIds
        )
      ),
    });
  };
