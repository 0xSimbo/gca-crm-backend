import { db } from "../src/db/db";
import { users, referrals } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { canClaimReferrer } from "../src/routers/referral-router/helpers/referral-validation";

async function checkWallet(wallet: string) {
  const normalized = wallet.toLowerCase();
  console.log(`Checking wallet: ${normalized}`);

  const user = await db.query.users.findFirst({
    where: (u, { eq, sql }) => eq(sql`lower(${u.id})`, normalized),
  });
  console.log(`User record (lower match): ${user ? JSON.stringify(user) : "Not found"}`);

  const referral = await db.query.referrals.findFirst({
    where: (r, { eq, sql }) => eq(sql`lower(${r.refereeWallet})`, normalized),
  });
  console.log(`Referral record (lower match): ${referral ? JSON.stringify(referral) : "Not found"}`);

  const claimCheck = await canClaimReferrer(normalized);
  console.log(`Claim check: ${JSON.stringify(claimCheck)}`);
}

const WALLET = "0x5e230FED487c86B90f6508104149F087d9B1B0A7";
checkWallet(WALLET).then(() => process.exit(0));
