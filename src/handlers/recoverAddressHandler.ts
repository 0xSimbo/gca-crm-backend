import { verifyTypedData } from "ethers";
import { db } from "../db/db";
import { eq } from "drizzle-orm";
import { Accounts } from "../db/schema";

export const recoverAddressHandler = async (
  types: any,
  values: any,
  signature: string,
  accountId: string
) => {
  const account = await db.query.Accounts.findFirst({
    where: eq(Accounts.id, accountId),
  });
  if (!account) {
    throw new Error("Account not found");
  }

  const signerAddress = verifyTypedData(
    {
      name: "Glow Crm",
      version: "1",
      chainId: process.env.NODE_ENV === "staging" ? 11155111 : 1,
    },
    types,
    {
      ...values,
      nonce: account.siweNonce,
    },
    signature
  );
  return signerAddress;
};
