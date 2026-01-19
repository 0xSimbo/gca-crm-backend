const BASE_URL = "http://localhost:3005";
const TEST_WALLET = "0x77f41144e787cb8cd29a37413a71f53f92ee050c";

async function testImpactScore() {
  console.log(`🔍 Testing /impact/glow-score for ${TEST_WALLET}\n`);

  try {
    const res = await fetch(`${BASE_URL}/impact/glow-score?walletAddress=${TEST_WALLET}`);
    if (!res.ok) {
      console.error(`❌ Failed: ${res.status} ${await res.text()}`);
      return;
    }

    const data = await res.json() as any;
    console.log("✅ Impact Score response received");
    console.log(`   Total Points: ${data.totals.totalPoints}`);
    console.log(`   Referral Data present: ${!!data.referral}`);
    
    if (data.referral) {
      console.log(`   As Referrer: ${JSON.stringify(data.referral.asReferrer)}`);
      console.log(`   Composition Referral Points: ${data.composition.referralPoints}`);
    }

    console.log("\n✨ Test complete!");
  } catch (e) {
    console.error(e);
  }
}

testImpactScore();
