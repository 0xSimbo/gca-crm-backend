import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const createAccount = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number],
  jti: string
) => {
  await db.insert(accounts).values({
    id: wallet,
    role,
    jti,
  });
  return {
    id: wallet,
    role,
  };
};
