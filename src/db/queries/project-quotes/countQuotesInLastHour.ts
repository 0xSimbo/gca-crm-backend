import { db } from "../../db";
import { ProjectQuotes } from "../../schema";
import { gte, sql } from "drizzle-orm";

export async function countQuotesInLastHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(ProjectQuotes)
    .where(gte(ProjectQuotes.createdAt, oneHourAgo));

  return Number(result[0]?.count ?? 0);
}

