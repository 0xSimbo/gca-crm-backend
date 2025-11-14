import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function findProjectQuoteById(id: string) {
  const quote = await db.query.ProjectQuotes.findFirst({
    where: eq(ProjectQuotes.id, id),
  });
  return quote;
}

