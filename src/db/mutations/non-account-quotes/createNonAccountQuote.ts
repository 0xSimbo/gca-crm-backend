import { db } from "../../db";
import { NonAccountQuotes, NonAccountQuoteInsertType } from "../../schema";

export async function createNonAccountQuote(data: NonAccountQuoteInsertType) {
  const [quote] = await db.insert(NonAccountQuotes).values(data).returning();
  return quote;
}

