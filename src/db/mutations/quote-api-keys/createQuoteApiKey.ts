import { db } from "../../db";
import { QuoteApiKeys, type QuoteApiKeyInsertType } from "../../schema";

export async function createQuoteApiKey(data: QuoteApiKeyInsertType) {
  const [created] = await db.insert(QuoteApiKeys).values(data).returning();
  if (!created) {
    throw new Error("Failed to create quote api key");
  }
  return created;
}


