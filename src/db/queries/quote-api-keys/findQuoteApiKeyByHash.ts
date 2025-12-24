import { db } from "../../db";
import { QuoteApiKeys } from "../../schema";
import { and, eq, isNull } from "drizzle-orm";

export async function findQuoteApiKeyByHash(apiKeyHash: string) {
  const [row] = await db
    .select()
    .from(QuoteApiKeys)
    .where(and(eq(QuoteApiKeys.apiKeyHash, apiKeyHash), isNull(QuoteApiKeys.revokedAt)));
  return row ?? null;
}


