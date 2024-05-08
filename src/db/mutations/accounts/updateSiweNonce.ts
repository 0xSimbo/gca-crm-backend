import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts, accountRoleEnum } from "../../schema";

export const updateSiweNonce = async (wallet: string, siweNonce: string) => {
  await db
    .update(accounts)
    .set({
      siweNonce,
    })
    .where(eq(accounts.id, wallet));

  return {
    id: wallet,
    siweNonce,
  };
};
