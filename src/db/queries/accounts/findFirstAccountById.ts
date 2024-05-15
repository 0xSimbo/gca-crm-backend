import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Accounts } from "../../schema";

export const findFirstAccountById = async (id: string) => {
  const account = await db.query.Accounts.findFirst({
    where: eq(Accounts.id, id),
    with: {
      gca: true,
      user: true,
    },
  });
  return account;
};
