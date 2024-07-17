import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllOrgMembersWithDocumentsAccessWithoutOwner = async (
  applicationOwnerId: string,
  organizationId: string
) => {
  return await db.query.OrganizationUsers.findMany({
    where: and(
      eq(OrganizationUsers.organizationId, organizationId),
      eq(OrganizationUsers.hasDocumentsAccess, true),
      ne(OrganizationUsers.userId, applicationOwnerId)
    ),
    columns: {
      userId: true,
      id: true,
    },
  });
};
