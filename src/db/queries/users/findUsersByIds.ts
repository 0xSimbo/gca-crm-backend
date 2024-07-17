import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../schema";

export const findUsersByIds = async (ids: string[]) => {
  const usersDb = await db.query.users.findMany({
    columns: {
      id: true,
    },
    with: {
      organizationUser: {
        columns: {
          id: true,
        },
      },
      gcaDelegatedUser: {
        columns: {
          id: true,
        },
      },
    },
    where: inArray(users.id, ids),
  });
  return usersDb;
};
