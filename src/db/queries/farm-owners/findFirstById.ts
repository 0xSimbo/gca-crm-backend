import { eq } from "drizzle-orm";
import { db } from "../../db";
import { FarmOwners } from "../../schema";

export const FindFirstById = async (id: string) => {
  const farmOwner = await db.query.FarmOwners.findFirst({
    where: eq(FarmOwners.id, id),
  });
  return farmOwner;
};
