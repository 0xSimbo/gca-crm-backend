import { eq } from "drizzle-orm";
import { db } from "../../db";
import { GcaDelegatedUsers } from "../../schema";

export const findFirstDelegatedUserByUserId = async (userId: string) => {
  const gcaDelegatedUser = await db.query.GcaDelegatedUsers.findFirst({
    where: eq(GcaDelegatedUsers.userId, userId),
  });
  return gcaDelegatedUser;
};
