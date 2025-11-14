import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function findProjectQuotesByUserId(userId: string) {
  return await db.query.ProjectQuotes.findMany({
    where: eq(ProjectQuotes.userId, userId),
    orderBy: (quotes, { desc }) => [desc(quotes.createdAt)],
  });
}
