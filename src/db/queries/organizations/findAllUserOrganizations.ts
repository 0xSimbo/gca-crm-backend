import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllUserOrganizations = async (userId: string) => {
  const organizationDb = await db.query.OrganizationUsers.findMany({
    where: eq(OrganizationUsers.userId, userId),
    with: {
      role: true,
      organization: true,
    },
  });
  return organizationDb;
};
