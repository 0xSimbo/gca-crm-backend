import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ProjectQuotes } from "../../schema";

export async function findProjectQuotesByWalletAddress(walletAddress: string) {
  return await db.query.ProjectQuotes.findMany({
    where: eq(ProjectQuotes.walletAddress, walletAddress),
    orderBy: (quotes, { desc }) => [desc(quotes.createdAt)],
  });
}
