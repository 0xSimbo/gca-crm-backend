import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Accounts } from "../../schema";

export const updateSiweNonce = async (wallet: string, siweNonce: string) => {
  await db
    .update(Accounts)
    .set({
      siweNonce,
    })
    .where(eq(Accounts.id, wallet));

  return {
    id: wallet,
    siweNonce,
  };
};
