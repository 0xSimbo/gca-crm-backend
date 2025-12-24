import { and, isNull } from "drizzle-orm";
import { db } from "../../db";
import { QuoteApiKeys } from "../../schema";

export async function findActiveQuoteApiKeys() {
  return await db
    .select({
      orgName: QuoteApiKeys.orgName,
      apiKeyHash: QuoteApiKeys.apiKeyHash,
      walletAddress: QuoteApiKeys.walletAddress,
    })
    .from(QuoteApiKeys)
    .where(and(isNull(QuoteApiKeys.revokedAt)));
}


