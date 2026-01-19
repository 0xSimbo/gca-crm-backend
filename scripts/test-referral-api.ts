const BASE_URL = "http://localhost:3005";
const TEST_WALLET = "0x77f41144e787cb8cd29a37413a71f53f92ee050c"; // Valid 42-char address

async function runTests() {
  console.log(`🚀 Testing Referral API at ${BASE_URL}\n`);

  // 1. Test /referral/code
  console.log("1️⃣  Testing GET /referral/code...");
  const codeRes = await fetch(`${BASE_URL}/referral/code?walletAddress=${TEST_WALLET}`);
  if (!codeRes.ok) {
    const errorBody = await codeRes.text();
    console.error(`❌ Failed /referral/code: ${codeRes.status} ${errorBody}`);
  } else {
    const data = await codeRes.json() as any;
    console.log(`✅ Success /referral/code: code=${data.code}, link=${data.shareableLink}`);
    
    // 2. Test /referral/validate/:code
    console.log("\n2️⃣  Testing GET /referral/validate/:code...");
    const validateRes = await fetch(`${BASE_URL}/referral/validate/${data.code}`);
    if (!validateRes.ok) {
      console.error(`❌ Failed /referral/validate: ${validateRes.status} ${await validateRes.text()}`);
    } else {
      const vData = await validateRes.json() as any;
      console.log(`✅ Success /referral/validate: valid=${vData.valid}, referrerWallet=${vData.referrerWallet}`);
    }
  }

  // 3. Test /referral/status
  console.log("\n3️⃣  Testing GET /referral/status...");
  const statusRes = await fetch(`${BASE_URL}/referral/status?walletAddress=${TEST_WALLET}`);
  if (!statusRes.ok) {
    console.error(`❌ Failed /referral/status: ${statusRes.status} ${await statusRes.text()}`);
  } else {
    const data = await statusRes.json() as any;
    console.log(`✅ Success /referral/status: hasReferrer=${data.hasReferrer}, canClaim=${data.canClaim}, nonce=${data.nonce}`);
  }

  // 4. Test /referral/network
  console.log("\n4️⃣  Testing GET /referral/network...");
  const networkRes = await fetch(`${BASE_URL}/referral/network?walletAddress=${TEST_WALLET}`);
  if (!networkRes.ok) {
    console.error(`❌ Failed /referral/network: ${networkRes.status} ${await networkRes.text()}`);
  } else {
    const data = await networkRes.json() as any;
    console.log(`✅ Success /referral/network: totalReferees=${data.stats.totalReferees}, activeReferees=${data.stats.activeReferees}, tier=${data.stats.currentTier.name}`);
  }

  // 5. Test /referral/leaderboard
  console.log("\n5️⃣  Testing GET /referral/leaderboard...");
  const lbRes = await fetch(`${BASE_URL}/referral/leaderboard`);
  if (!lbRes.ok) {
    console.error(`❌ Failed /referral/leaderboard: ${lbRes.status} ${await lbRes.text()}`);
  } else {
    const data = await lbRes.json() as any;
    console.log(`✅ Success /referral/leaderboard: leaderboardSize=${data.leaderboard.length}, eventStatus=${data.eventStatus}`);
  }

  console.log("\n🏁 API tests complete!");
}

runTests().catch(console.error);
