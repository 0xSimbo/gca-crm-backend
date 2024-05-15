import { db } from "../../db";
import { AccountInsertType, Accounts } from "../../schema";

export const createAccount = async (args: AccountInsertType) => {
  await db.insert(Accounts).values(args);
  return args;
};
