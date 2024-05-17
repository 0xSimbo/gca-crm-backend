import { ethers } from "ethers";
import { db } from "../db/db";
import { eq } from "drizzle-orm";
import { Accounts } from "../db/schema";

export const recoverAddressHandler = async (
  message: string,
  signature: string,
  accountId: string
) => {
  const account = await db.query.Accounts.findFirst({
    where: eq(Accounts.id, accountId),
  });
  if (!account) {
    throw new Error("Account not found");
  }
  const address = ethers.utils.verifyMessage(
    message + account.siweNonce + account.salt,
    signature
  );
  return address;
};
