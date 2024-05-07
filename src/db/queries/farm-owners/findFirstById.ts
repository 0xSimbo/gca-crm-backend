import { eq } from "drizzle-orm";
import { db } from "../../db";
import { farmOwners } from "../../schema";

export const FindFirstById = async (id: string) => {
  const farmOwner = await db.query.farmOwners.findFirst({
    where: eq(farmOwners.id, id),
  });
  return farmOwner;
};
