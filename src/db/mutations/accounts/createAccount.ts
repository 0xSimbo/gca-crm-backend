import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const createAccount = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number]
) => {
  const account = await db.insert(accounts).values({
    id: wallet,
    role,
  });
  return account;
};
