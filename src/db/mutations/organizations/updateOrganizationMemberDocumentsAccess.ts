import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const updateOrganizationMemberDocumentsAccess = async (
  organizationUserId: string,
  hasDocumentsAccess: boolean
) => {
  await db
    .update(OrganizationUsers)
    .set({
      hasDocumentsAccess,
    })
    .where(eq(OrganizationUsers.id, organizationUserId));
};
