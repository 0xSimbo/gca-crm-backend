import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const updateRole = async (
  wallet: string,
  role: (typeof accountRoleEnum.enumValues)[number]
) => {
  await db
    .update(accounts)
    .set({
      role,
    })
    .where(eq(accounts.id, wallet));

  return {
    id: wallet,
    role,
  };
};
