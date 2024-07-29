import { eq } from "drizzle-orm";
import { db } from "../../db";
import { farms } from "../../schema";

export const findFirstFarmById = async (farmId: string) => {
  const farmDb = await db.query.farms.findFirst({
    where: eq(farms.id, farmId),
  });
  return farmDb;
};
