import { db } from "../../db";
import { QuoteApiKeys } from "../../schema";
import { eq } from "drizzle-orm";

export async function findQuoteApiKeyByOrgName(orgName: string) {
  const [row] = await db
    .select()
    .from(QuoteApiKeys)
    .where(eq(QuoteApiKeys.orgName, orgName));
  return row ?? null;
}


