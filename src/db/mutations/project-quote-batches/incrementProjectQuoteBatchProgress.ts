import { db } from "../../db";
import { ProjectQuoteBatches } from "../../schema";
import { eq, sql } from "drizzle-orm";

export async function incrementProjectQuoteBatchProgress(args: {
  batchId: string;
  isSuccess: boolean;
}) {
  const set: Record<string, unknown> = {
    processedCount: sql`${ProjectQuoteBatches.processedCount} + 1`,
  };

  if (args.isSuccess) {
    set.successCount = sql`${ProjectQuoteBatches.successCount} + 1`;
  } else {
    set.errorCount = sql`${ProjectQuoteBatches.errorCount} + 1`;
  }

  const [updated] = await db
    .update(ProjectQuoteBatches)
    .set(set)
    .where(eq(ProjectQuoteBatches.id, args.batchId))
    .returning();

  return updated ?? null;
}


