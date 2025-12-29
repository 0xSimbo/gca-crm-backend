import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function countLebanonQuotesInLastHour(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(ProjectQuotes)
    .where(
      and(gte(ProjectQuotes.createdAt, oneHourAgo), eq(ProjectQuotes.regionCode, "LB"))
    );

  return Number(result[0]?.count ?? 0);
}


