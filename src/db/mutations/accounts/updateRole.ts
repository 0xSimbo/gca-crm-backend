import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Accounts, accountRoleEnum } from "../../schema";

export const updateRole = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number]
) => {
  await db
    .update(Accounts)
    .set({
      role,
    })
    .where(eq(Accounts.id, wallet));

  return {
    id: wallet,
    role,
  };
};
