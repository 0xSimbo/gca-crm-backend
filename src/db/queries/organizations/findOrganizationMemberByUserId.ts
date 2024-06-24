import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findOrganizationMemberByUserId = async (
  organizationId: string,
  userId: string
) => {
  const organizationMemberDb = await db.query.OrganizationUsers.findFirst({
    where: and(
      eq(OrganizationUsers.organizationId, organizationId),
      eq(OrganizationUsers.userId, userId)
    ),
    with: {
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
  return organizationMemberDb;
};
