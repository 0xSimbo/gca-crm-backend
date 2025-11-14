import { db } from "../../db";
import { ProjectQuotes, ProjectQuoteInsertType } from "../../schema";

export async function createProjectQuote(data: ProjectQuoteInsertType) {
  const [quote] = await db.insert(ProjectQuotes).values(data).returning();
  return quote;
}
