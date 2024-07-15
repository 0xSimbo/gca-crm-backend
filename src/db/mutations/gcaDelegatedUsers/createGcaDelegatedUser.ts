import { db } from "../../db";
import { GcaDelegatedUsers, GcaDelegatedUsersInsertType } from "../../schema";

export const createGcaDelegatedUser = async (
  gcaDelegatedUser: GcaDelegatedUsersInsertType
) => {
  const insertRes = await db
    .insert(GcaDelegatedUsers)
    .values(gcaDelegatedUser)
    .returning({
      id: GcaDelegatedUsers.id,
    });
  return insertRes[0].id;
};
