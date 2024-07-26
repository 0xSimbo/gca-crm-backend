import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findAllUserOrganizationsWithMembersWithDocumentsAccess = async (
  userId: string
) => {
  return await db.query.OrganizationUsers.findMany({
    where: eq(OrganizationUsers.userId, userId),
    with: {
      organization: {
        with: {
          users: {
            where: eq(OrganizationUsers.hasDocumentsAccess, true),
            columns: {
              id: true,
            },
            with: {
              user: {
                columns: {
                  id: true,
                  publicEncryptionKey: true,
                },
              },
            },
          },
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
};
