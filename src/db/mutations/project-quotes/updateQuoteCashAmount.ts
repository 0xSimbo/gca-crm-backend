import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function updateQuoteCashAmount(
  quoteId: string,
  cashAmountUsd: string
) {
  const [updatedQuote] = await db
    .update(ProjectQuotes)
    .set({ cashAmountUsd })
    .where(eq(ProjectQuotes.id, quoteId))
    .returning();

  return updatedQuote;
}
