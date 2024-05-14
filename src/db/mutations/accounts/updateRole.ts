import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Accounts } from "../../schema";
import { accountRoleEnum } from "../../enums";

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
