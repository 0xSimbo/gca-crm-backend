import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users, UserUpdateType } from "../../schema";

export const updateUser = async (user: UserUpdateType, userId: string) => {
  await db.update(users).set(user).where(eq(users.id, userId));
  return user;
};
