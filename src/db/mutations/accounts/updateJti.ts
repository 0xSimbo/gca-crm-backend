import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const updateJti = async (wallet: string, jti: string) => {
  await db
    .update(accounts)
    .set({
      jti,
    })
    .where(eq(accounts.id, wallet));

  return {
    id: wallet,
    jti,
  };
};
