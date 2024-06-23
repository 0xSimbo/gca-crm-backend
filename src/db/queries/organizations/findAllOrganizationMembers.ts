import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllOrganizationMembers = async (organizationId: string) => {
  const organizationMembersDb = await db.query.OrganizationUsers.findMany({
    where: eq(OrganizationUsers.organizationId, organizationId),
    with: {
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      role: true,
    },
  });
  return organizationMembersDb;
};
