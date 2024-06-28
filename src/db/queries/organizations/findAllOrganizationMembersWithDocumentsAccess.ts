import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllOrganizationMembersWithDocumentsAccess = async (
  organizationId: string
) => {
  const organizationMembersDb = await db.query.OrganizationUsers.findMany({
    where: and(
      eq(OrganizationUsers.organizationId, organizationId),
      eq(OrganizationUsers.hasDocumentsAccess, true)
    ),
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
      role: true,
    },
  });
  return organizationMembersDb;
};
