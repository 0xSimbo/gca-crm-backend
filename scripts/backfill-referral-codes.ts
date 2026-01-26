import { db } from "../src/db/db";
import { wallets, referralCodes } from "../src/db/schema";
import { getOrCreateReferralCode } from "../src/routers/referral-router/helpers/referral-code";
import { getImpactLeaderboardWalletUniverse } from "../src/routers/impact-router/helpers/impact-score";

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log(`🚀 Starting referral codes backfill (Dry Run: ${isDryRun})`);

  // Get wallets from multiple sources
  console.log("📡 Fetching wallet universe...");

  const [dbWallets, impactUniverse] = await Promise.all([
    db.select({ id: wallets.id }).from(wallets),
    getImpactLeaderboardWalletUniverse({ limit: 10000 }),
  ]);

  // Combine and dedupe (normalize to lowercase)
  const walletSet = new Set<string>();
  for (const w of dbWallets) walletSet.add(w.id.toLowerCase());
  for (const w of impactUniverse.eligibleWallets) walletSet.add(w.toLowerCase());

  const allWallets = Array.from(walletSet).map((id) => ({ id }));

  console.log(`📊 Found ${allWallets.length} unique wallets to process`);
  console.log(`   - DB wallets table: ${dbWallets.length}`);
  console.log(`   - Impact universe: ${impactUniverse.eligibleWallets.length}`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const wallet of allWallets) {
    try {
      if (isDryRun) {
        const existing = await db.query.referralCodes.findFirst({
          where: (rc, { eq }) => eq(rc.walletAddress, wallet.id.toLowerCase()),
        });
        if (existing) {
          skipped++;
        } else {
          console.log(`[Dry Run] Would create code for ${wallet.id}`);
          created++;
        }
        continue;
      }

      const record = await getOrCreateReferralCode(wallet.id);
      if (record) {
        created++;
      } else {
        skipped++;
      }
    } catch (e) {
      console.error(`❌ Error processing wallet ${wallet.id}:`, e);
      errors++;
    }

    if ((created + skipped + errors) % 50 === 0) {
      console.log(`🕒 Progress: ${created + skipped + errors}/${allWallets.length}...`);
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📊 BACKFILL SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ Codes Created: ${created}`);
  console.log(`⏭️  Already Exists: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error during backfill:", e);
  process.exit(1);
});
