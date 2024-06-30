import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const updateOrganizationMemberRole = async (
  organizationUserId: string,
  roleId: string
) => {
  return await db
    .update(OrganizationUsers)
    .set({
      roleId,
    })
    .where(eq(OrganizationUsers.id, organizationUserId));
};
