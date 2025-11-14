import { db } from "../db/db";
import { Accounts } from "../db/schema";
import { eq, sql } from "drizzle-orm";

export async function mapWalletToUserId(
  walletAddress: string
): Promise<string | null> {
  try {
    // Case-insensitive search for wallet address
    const account = await db.query.Accounts.findFirst({
      where: sql`LOWER(${Accounts.id}) = LOWER(${walletAddress})`,
    });
    return account ? account.id : null;
  } catch (error) {
    console.error("Error mapping wallet to userId:", error);
    return null;
  }
}
