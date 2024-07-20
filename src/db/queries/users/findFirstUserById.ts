import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../schema";

export const findFirstUserById = async (id: string) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
    with: {
      installer: true,
      gcaDelegatedUser: true,
      organizationUser: {
        columns: {
          id: true,
          hasDocumentsAccess: true,
          organizationId: true,
        },
      },
    },
  });
  return user;
};
