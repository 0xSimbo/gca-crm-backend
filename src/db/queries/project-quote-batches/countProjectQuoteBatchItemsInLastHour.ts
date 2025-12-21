import { db } from "../../db";
import { ProjectQuoteBatches } from "../../schema";
import { gte, sql } from "drizzle-orm";

export async function countProjectQuoteBatchItemsInLastHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await db
    .select({
      count: sql<number>`coalesce(sum(${ProjectQuoteBatches.itemCount}), 0)`,
    })
    .from(ProjectQuoteBatches)
    .where(gte(ProjectQuoteBatches.createdAt, oneHourAgo));

  return Number(result[0]?.count ?? 0);
}


