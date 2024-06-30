import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllOrganizationMembers = async (organizationId: string) => {
  const organizationMembersDb = await db.query.OrganizationUsers.findMany({
    where: eq(OrganizationUsers.organizationId, organizationId),
    with: {
      user: {
        columns: {
          publicEncryptionKey: true,
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      role: {
        with: {
          rolePermissions: {
            with: {
              permission: true,
            },
          },
        },
      },
    },
  });
  return organizationMembersDb;
};
