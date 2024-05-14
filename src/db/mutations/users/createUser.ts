import { db } from "../../db";
import { users, UserInsertType } from "../../schema";

export const createUser = async (user: UserInsertType) => {
  await db.insert(users).values(user);
  return user;
};
