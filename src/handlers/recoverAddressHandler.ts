import { ethers } from "ethers";
import { db } from "../db/db";
import { eq } from "drizzle-orm";
import { Accounts } from "../db/schema";

export const recoverAddressHandler = async (
  message: string,
  signature: string,
  wallet: string
) => {
  const account = await db.query.Accounts.findFirst({
    where: eq(Accounts.id, wallet),
  });
  if (!account) {
    throw new Error("Account not found");
  }
  const address = ethers.utils.verifyMessage(
    message + account.siweNonce,
    signature
  );
  return address;
};
