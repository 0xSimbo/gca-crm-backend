import { eq } from "drizzle-orm";
import { db } from "../../db";
import { accounts } from "../../schema";

export const FindFirstById = async (id: string) => {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, id),
    with: {
      gca: true,
      farmOwner: true,
    },
  });
  return account;
};
