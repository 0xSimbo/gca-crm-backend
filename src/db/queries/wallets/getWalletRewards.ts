import { eq } from "drizzle-orm";
import { db } from "../../db";
import { wallets } from "../../schema";

export const getWalletRewards = async (walletId: string) => {
  return await db.query.wallets.findFirst({
    where: eq(wallets.id, walletId),
  });
};
