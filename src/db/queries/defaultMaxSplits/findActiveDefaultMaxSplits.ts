import { eq } from "drizzle-orm";
import { db } from "../../db";
import { defaultMaxSplits } from "../../schema";

export async function findActiveDefaultMaxSplits() {
  return await db
    .select()
    .from(defaultMaxSplits)
    .where(eq(defaultMaxSplits.isActive, true))
    .orderBy(defaultMaxSplits.createdAt)
    .limit(1);
}
