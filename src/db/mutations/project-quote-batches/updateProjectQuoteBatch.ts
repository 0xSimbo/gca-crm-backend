import { db } from "../../db";
import { ProjectQuoteBatches } from "../../schema";
import { eq } from "drizzle-orm";

export async function updateProjectQuoteBatch(
  batchId: string,
  data: Partial<typeof ProjectQuoteBatches.$inferInsert>
) {
  const [updated] = await db
    .update(ProjectQuoteBatches)
    .set(data)
    .where(eq(ProjectQuoteBatches.id, batchId))
    .returning();
  return updated ?? null;
}


