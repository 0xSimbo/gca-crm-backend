/**
 * Debug script: investigate why /solar-collector/stats returns 0 watts for a wallet
 * while /impact/delegators-leaderboard shows the wallet has impact score.
 *
 * Usage:
 *   bun run scripts/debug-solar-collector.ts --wallet 0x77f41144E787CB8Cd29A37413A71F53f92ee050C
 *   bun run scripts/debug-solar-collector.ts --baseUrl http://localhost:3005 --wallet 0x...
 */

interface Args {
  baseUrl: string;
  wallet: string;
}

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseArgs(argv: string[]): Args {
  const baseUrl = getArgValue(argv, "--baseUrl") ?? "http://localhost:3005";
  const wallet = getArgValue(argv, "--wallet");

  if (!wallet) throw new Error("Missing --wallet argument");
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("Invalid wallet address format");

  return { baseUrl, wallet };
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

async function withTimeout<T>(
  label: string,
  ms: number,
  promise: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ])) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchJson<T = unknown>(url: string, label: string): Promise<{ data: T | null; ms: number; status: number; error?: string }> {
  const start = nowMs();
  try {
    const res = await withTimeout(label, 120_000, fetch(url, { cache: "no-store" }));
    const text = await res.text().catch(() => "");
    const ms = nowMs() - start;

    if (!res.ok) {
      return { data: null, ms, status: res.status, error: text };
    }

    try {
      const json = JSON.parse(text) as T;
      return { data: json, ms, status: res.status };
    } catch {
      return { data: null, ms, status: res.status, error: "Failed to parse JSON" };
    }
  } catch (e) {
    const ms = nowMs() - start;
    return { data: null, ms, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

interface SolarCollectorStats {
  totalWatts: number;
  panels: number;
  ghostProgress: number;
  streakStatus: {
    weeks: number;
    isActive: boolean;
    atRisk: boolean;
    multiplier: number;
  };
}

interface DelegatorsLeaderboardWallet {
  wallet?: string;
  walletAddress?: string;
  totalPoints?: string;
  points?: string;
  rank?: number;
  glowWorthWei?: string;
  lastWeekPoints?: string;
  netRewards?: string;
  grossRewards?: string;
  [key: string]: unknown;
}

interface DelegatorsLeaderboard {
  weekRange: { startWeek: number; endWeek: number };
  limit: number;
  totalWalletCount: number;
  wallets: DelegatorsLeaderboardWallet[];
}

interface GlowScoreWallet {
  walletAddress?: string;
  wallet?: string;
  totalPoints?: string;
  points?: string;
  rank?: number;
  glowWorthWei?: string;
  weekly?: Array<{
    weekNumber: number;
    rolloverPoints: string;
    basePoints: string;
  }>;
  [key: string]: unknown;
}

interface GlowScoreResponse {
  weekRange?: { startWeek: number; endWeek: number };
  wallets?: GlowScoreWallet[];
  walletAddress?: string;
  totals?: {
    totalPoints?: string;
    rolloverPoints?: string;
    [key: string]: unknown;
  };
  weekly?: Array<{
    weekNumber: number;
    rolloverPoints: string;
    basePoints: string;
  }>;
  [key: string]: unknown;
}

async function main() {
  const args = parseArgs(process.argv);
  const wallet = args.wallet.toLowerCase();

  console.log("=".repeat(80));
  console.log("DEBUG SOLAR COLLECTOR STATS");
  console.log("=".repeat(80));
  console.log("baseUrl:", args.baseUrl);
  console.log("wallet:", args.wallet);
  console.log("");

  // 1. Fetch /solar-collector/stats
  console.log("1. Fetching /solar-collector/stats...");
  const statsUrl = `${args.baseUrl}/solar-collector/stats?walletAddress=${args.wallet}`;
  const statsResult = await fetchJson<SolarCollectorStats>(statsUrl, "solar-collector/stats");
  
  console.log(`   Status: ${statsResult.status} (${Math.round(statsResult.ms)}ms)`);
  if (statsResult.error) {
    console.log(`   Error: ${statsResult.error}`);
  } else if (statsResult.data) {
    console.log(`   totalWatts: ${statsResult.data.totalWatts}`);
    console.log(`   panels: ${statsResult.data.panels}`);
    console.log(`   ghostProgress: ${statsResult.data.ghostProgress.toFixed(2)}%`);
    console.log(`   streakStatus:`, JSON.stringify(statsResult.data.streakStatus));
  }
  console.log("");

  // 2. Fetch /impact/delegators-leaderboard to see if wallet is there
  console.log("2. Fetching /impact/delegators-leaderboard (limit=500)...");
  const delegatorsUrl = `${args.baseUrl}/impact/delegators-leaderboard?limit=500`;
  const delegatorsResult = await fetchJson<DelegatorsLeaderboard>(delegatorsUrl, "delegators-leaderboard");

  console.log(`   Status: ${delegatorsResult.status} (${Math.round(delegatorsResult.ms)}ms)`);
  if (delegatorsResult.error) {
    console.log(`   Error: ${delegatorsResult.error}`);
  } else if (delegatorsResult.data) {
    console.log(`   weekRange: ${delegatorsResult.data.weekRange?.startWeek} - ${delegatorsResult.data.weekRange?.endWeek}`);
    console.log(`   totalWalletCount: ${delegatorsResult.data.totalWalletCount}`);
    console.log(`   wallets returned: ${delegatorsResult.data.wallets?.length ?? 0}`);
    
    // Log first wallet structure to understand the format
    if (delegatorsResult.data.wallets?.[0]) {
      console.log(`   First wallet keys: ${Object.keys(delegatorsResult.data.wallets[0]).join(", ")}`);
    }
    
    const walletEntry = delegatorsResult.data.wallets?.find(
      (w) => (w.walletAddress || w.wallet || "").toLowerCase() === wallet
    );
    if (walletEntry) {
      console.log(`   ✅ Wallet FOUND in delegators leaderboard:`);
      console.log(`      raw entry: ${JSON.stringify(walletEntry)}`);
    } else {
      console.log(`   ❌ Wallet NOT found in top ${delegatorsResult.data.wallets?.length ?? 0} delegators`);
    }
  }
  console.log("");

  // 3. Fetch /impact/glow-score for this specific wallet with weekly breakdown
  console.log("3. Fetching /impact/glow-score for wallet with weekly breakdown...");
  const glowScoreUrl = `${args.baseUrl}/impact/glow-score?walletAddress=${args.wallet}&includeWeekly=true`;
  const glowScoreResult = await fetchJson<GlowScoreResponse>(glowScoreUrl, "glow-score");

  let glowScoreTotalPoints = 0;
  let glowScoreWeekly: Array<{ weekNumber: number; rolloverPoints: string; basePoints: string }> = [];

  console.log(`   Status: ${glowScoreResult.status} (${Math.round(glowScoreResult.ms)}ms)`);
  if (glowScoreResult.error) {
    console.log(`   Error: ${glowScoreResult.error}`);
  } else if (glowScoreResult.data) {
    const data = glowScoreResult.data;
    console.log(`   Response keys: ${Object.keys(data).join(", ")}`);
    
    if (data.weekRange) {
      console.log(`   weekRange: ${data.weekRange.startWeek} - ${data.weekRange.endWeek}`);
    }
    
    // Handle single wallet response format (when walletAddress is provided)
    if (data.walletAddress) {
      console.log(`   walletAddress: ${data.walletAddress}`);
      
      if (data.totals) {
        console.log(`   totals keys: ${Object.keys(data.totals).join(", ")}`);
        const totalPoints = data.totals.totalPoints || data.totals.rolloverPoints || "0";
        glowScoreTotalPoints = parseFloat(totalPoints);
        console.log(`   totalPoints: ${totalPoints}`);
      }
      
      if (data.weekly && Array.isArray(data.weekly)) {
        glowScoreWeekly = data.weekly;
        console.log(`   weekly breakdown (${data.weekly.length} weeks):`);
        
        // Show weeks with non-zero points
        const weeksWithPoints = data.weekly.filter((w) => parseFloat(w.rolloverPoints || "0") > 0);
        console.log(`   weeks with points > 0: ${weeksWithPoints.length}`);
        
        // Show first 5 weeks with points
        for (const w of weeksWithPoints.slice(0, 5)) {
          console.log(`      week ${w.weekNumber}: rollover=${w.rolloverPoints}, base=${w.basePoints}`);
        }
        if (weeksWithPoints.length > 5) {
          console.log(`      ... and ${weeksWithPoints.length - 5} more weeks`);
        }
      }
    }
    // Handle array response format (list mode)
    else if (data.wallets && data.wallets.length > 0) {
      const walletData = data.wallets[0];
      console.log(`   First wallet keys: ${Object.keys(walletData).join(", ")}`);
      glowScoreTotalPoints = parseFloat(walletData.totalPoints || walletData.points || "0");
      console.log(`   totalPoints: ${glowScoreTotalPoints}`);
    } else {
      console.log(`   Unknown response format`);
      console.log(`   Raw response: ${JSON.stringify(data).substring(0, 500)}`);
    }
  }
  console.log("");

  // 4. Check finalized farms
  console.log("4. Checking finalized farms via API (if available)...");
  // Try to get farm stats or list
  const farmsUrl = `${args.baseUrl}/farms?limit=10`;
  const farmsResult = await fetchJson<any>(farmsUrl, "farms");
  
  if (farmsResult.status === 404 || farmsResult.error) {
    console.log(`   Farms endpoint not available or returned error`);
    console.log(`   (This is expected if there's no public farms listing endpoint)`);
  } else if (farmsResult.data) {
    console.log(`   Farms data:`, JSON.stringify(farmsResult.data, null, 2).substring(0, 500));
  }
  console.log("");

  // 5. Analysis
  console.log("=".repeat(80));
  console.log("ANALYSIS");
  console.log("=".repeat(80));
  
  const hasImpactScore = glowScoreTotalPoints > 0;
  const hasDelegatorEntry = delegatorsResult.data?.wallets?.some(
    (w) => (w.walletAddress || w.wallet || "").toLowerCase() === wallet
  );
  const hasWatts = statsResult.data?.totalWatts && statsResult.data.totalWatts > 0;

  console.log(`Has impact score (${glowScoreTotalPoints.toFixed(2)} pts): ${hasImpactScore ? "✅ YES" : "❌ NO"}`);
  console.log(`In delegators leaderboard: ${hasDelegatorEntry ? "✅ YES" : "❌ NO"}`);
  console.log(`Has solar collector watts: ${hasWatts ? "✅ YES" : "❌ NO"}`);
  console.log("");

  if ((hasImpactScore || hasDelegatorEntry) && !hasWatts) {
    console.log("POTENTIAL ISSUES:");
    console.log("1. No finalized farms exist (farms with protocolFeePaymentHash)");
    console.log("2. Farms don't have audit fields with systemWattageOutput");
    console.log("3. impactLeaderboardCache doesn't have entries for farm drop weeks");
    console.log("4. Week calculation mismatch between farm payment date and impact score weeks");
    console.log("5. User's impact score weeks don't overlap with farm drop weeks");
    console.log("");
    console.log("DEBUG SQL QUERIES TO RUN:");
    console.log("```sql");
    console.log("-- Check finalized farms");
    console.log("SELECT COUNT(*) as finalized_farms FROM farms WHERE protocol_fee_payment_hash IS NOT NULL;");
    console.log("");
    console.log("-- Check farms with audit fields");
    console.log("SELECT f.farm_id, f.created_at, a.system_wattage_output");
    console.log("FROM farms f");
    console.log("JOIN applications app ON f.farm_id = app.farm_id");
    console.log("LEFT JOIN applications_audit_fields_crs a ON app.application_id = a.application_id");
    console.log("WHERE f.protocol_fee_payment_hash IS NOT NULL");
    console.log("LIMIT 10;");
    console.log("");
    console.log("-- Check impact_leaderboard_cache weeks");
    console.log("SELECT start_week, end_week, COUNT(*) as wallets");
    console.log("FROM impact_leaderboard_cache");
    console.log("GROUP BY start_week, end_week");
    console.log("ORDER BY start_week;");
    console.log("```");
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("debug-solar-collector FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();

