import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const deleteOrganizationUser = async (organizationUserId: string) => {
  await db
    .delete(OrganizationUsers)
    .where(eq(OrganizationUsers.id, organizationUserId));
};
