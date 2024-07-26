import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findOrganizationsMemberByUserIdAndOrganizationIds = async (
  organizationIds: string[],
  userId: string
) => {
  return await db.query.OrganizationUsers.findMany({
    where: and(
      inArray(OrganizationUsers.organizationId, organizationIds),
      eq(OrganizationUsers.userId, userId)
    ),
    with: {
      user: {
        columns: {
          publicEncryptionKey: true,
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
};
