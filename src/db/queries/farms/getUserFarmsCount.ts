import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { farms } from "../../schema";

export const getUserFarmsCount = async (userId: string) => {
  const farmsCount = await db
    .select({
      count: sql`count(*)`.mapWith(Number),
    })
    .from(farms)
    .where(eq(farms.userId, userId))
    .groupBy(farms.id);
  return farmsCount.reduce((acc, { count }) => acc + count, 0);
};
