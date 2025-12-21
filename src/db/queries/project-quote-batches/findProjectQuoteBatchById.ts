import { db } from "../../db";
import { ProjectQuoteBatches } from "../../schema";
import { eq } from "drizzle-orm";

export async function findProjectQuoteBatchById(batchId: string) {
  const [row] = await db
    .select()
    .from(ProjectQuoteBatches)
    .where(eq(ProjectQuoteBatches.id, batchId));
  return row ?? null;
}


