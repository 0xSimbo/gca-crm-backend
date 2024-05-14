import { db } from "../../db";
import { accountRoleEnum } from "../../enums";
import { Accounts } from "../../schema";

export const createAccount = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number],
  siweNonce: string
) => {
  await db.insert(Accounts).values({
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
