import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const createAccount = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number],
  siweNonce: string
) => {
  await db.insert(accounts).values({
    id: wallet,
    role,
    siweNonce,
  });
  return {
    id: wallet,
    role,
    siweNonce,
  };
};
