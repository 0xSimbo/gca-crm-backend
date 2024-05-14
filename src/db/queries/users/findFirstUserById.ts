import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../schema";

export const FindFirstUserById = async (id: string) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });
  return user;
};
