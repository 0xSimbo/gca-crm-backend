import { eq } from "drizzle-orm";
import { db } from "../../db";
import { NonAccountQuotes } from "../../schema";

export async function findNonAccountQuoteById(id: string) {
  const quote = await db.query.NonAccountQuotes.findFirst({
    where: eq(NonAccountQuotes.id, id),
  });
  return quote;
}

