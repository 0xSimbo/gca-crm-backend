import { db } from "../src/db/db";
import { referrals, referralCodes, referralPointsWeekly } from "../src/db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { getOrCreateReferralCode } from "../src/routers/referral-router/helpers/referral-code";
import { getReferrerStats, getReferrerTier } from "../src/routers/impact-router/helpers/referral-points";
import { viemClient } from "../src/lib/web3-providers/viem-client";

const WALLET = "0x77f41144e787cb8cd29a37413a71f53f92ee050c";

async function diagnose() {
  console.log(`🔍 Diagnosing /referral/network for ${WALLET}\n`);

  try {
    console.log("1. Testing getOrCreateReferralCode...");
    const codeRecord = await getOrCreateReferralCode(WALLET);
    console.log(`✅ Success: ${codeRecord.code}\n`);

    console.log("2. Testing getReferrerStats...");
    const stats = await getReferrerStats(WALLET);
    console.log(`✅ Success: ${JSON.stringify(stats)}\n`);

    console.log("3. Testing getReferrerTier...");
    const tier = getReferrerTier(stats.activeRefereeCount);
    console.log(`✅ Success: ${tier.name}\n`);

    console.log("4. Testing refereeList query...");
    const refereeList = await db
      .select({
        refereeWallet: referrals.refereeWallet,
        status: referrals.status,
        linkedAt: referrals.linkedAt,
        activatedAt: referrals.activatedAt,
        gracePeriodEndsAt: referrals.gracePeriodEndsAt,
      })
      .from(referrals)
      .where(eq(referrals.referrerWallet, WALLET))
      .orderBy(desc(referrals.linkedAt))
      .limit(50);
    console.log(`✅ Success: found ${refereeList.length} referees\n`);

    console.log("5. Testing weeklyPoints query...");
    const refereeWallets = refereeList.map((r) => r.refereeWallet);
    if (refereeWallets.length > 0) {
      const maxWeekRes = await db
        .select({ maxWeek: sql<number>`max(${referralPointsWeekly.weekNumber})` })
        .from(referralPointsWeekly);
      const maxWeek = maxWeekRes[0]?.maxWeek;
      console.log(`   Max week: ${maxWeek}`);

      const weeklyPoints = await db
        .select({
          refereeWallet: referralPointsWeekly.refereeWallet,
          thisWeekPoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}) filter (where ${referralPointsWeekly.weekNumber} = ${maxWeek || 0}), '0.000000')`,
          lifetimePoints: sql<string>`coalesce(sum(${referralPointsWeekly.referrerEarnedPointsScaled6}), '0.000000')`,
        })
        .from(referralPointsWeekly)
        .where(inArray(referralPointsWeekly.refereeWallet, refereeWallets))
        .groupBy(referralPointsWeekly.refereeWallet);
      console.log(`✅ Success: found ${weeklyPoints.length} points records\n`);
    } else {
      console.log("⏩ Skipped: no referees\n");
    }

    console.log("6. Testing ENS lookup...");
    const ensName = await viemClient.getEnsName({ address: WALLET as `0x${string}` });
    console.log(`✅ Success: ${ensName}\n`);

    console.log("✨ All logic parts passed!");
  } catch (e) {
    console.error("\n❌ FAILED at stage above:");
    console.error(e);
    process.exit(1);
  }
}

diagnose().catch(console.error);
