import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationsEncryptedMasterKeys } from "../../schema";

export const deleteAllOrganizationMemberEncryptedApplicationsMasterKeys =
  async (organizationUserId: string) => {
    return await db
      .delete(ApplicationsEncryptedMasterKeys)
      .where(
        eq(
          ApplicationsEncryptedMasterKeys.organizationUserId,
          organizationUserId
        )
      );
  };
