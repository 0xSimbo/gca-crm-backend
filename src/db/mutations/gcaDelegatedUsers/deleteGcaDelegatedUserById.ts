import { eq } from "drizzle-orm";
import { db } from "../../db";
import { GcaDelegatedUsers } from "../../schema";

export const deleteGcaDelegatedUserById = async (
  gcaDelegatedUserId: string
) => {
  await db
    .delete(GcaDelegatedUsers)
    .where(eq(GcaDelegatedUsers.id, gcaDelegatedUserId));
};
