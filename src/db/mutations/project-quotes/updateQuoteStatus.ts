import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function updateQuoteStatus(quoteId: string, status: string) {
  const [updatedQuote] = await db
    .update(ProjectQuotes)
    .set({ status })
    .where(eq(ProjectQuotes.id, quoteId))
    .returning();

  return updatedQuote;
}
