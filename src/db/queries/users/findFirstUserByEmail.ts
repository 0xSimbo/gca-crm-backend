import { eq, or } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../schema";

export const findFirstUserByEmail = async (email: string) => {
  const user = await db.query.users.findFirst({
    where: or(
      eq(users.email, email),
      eq(users.email, email.trim().toLowerCase())
    ),
  });
  return user;
};
