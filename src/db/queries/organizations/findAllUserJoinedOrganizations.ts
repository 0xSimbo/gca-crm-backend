import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllUserJoinedOrganizations = async (userId: string) => {
  const organizationDb = await db.query.OrganizationUsers.findMany({
    where: and(
      eq(OrganizationUsers.userId, userId),
      eq(OrganizationUsers.isAccepted, true)
    ),
    with: {
      role: true,
      organization: {
        with: {
          owner: {
            columns: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });
  return organizationDb;
};
