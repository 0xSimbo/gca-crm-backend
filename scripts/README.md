# Scripts

This directory contains utility scripts for database queries, debugging, and operations.

## Running Scripts

All scripts can be run using Bun:

```bash
bun run scripts/<script-name>.ts
```

## Table of Contents

- [Solar Panel Image Detection](#solar-panel-image-detection)
- [Project Quotes](#project-quotes)
- [Impact Leaderboard & Performance](#impact-leaderboard--performance)
- [Rewards & GLW Debugging](#rewards--glw-debugging)
- [Referral System](#referral-system)
- [Solar Collector Debugging & Diagnostics](#solar-collector-debugging)
- [Utilities](#utilities)

---

## Solar Panel Image Detection

AI-powered image analysis to identify which after-install photos show solar panels.

### `batch-identify-solar-panels.ts` - Create Batch Job (Recommended) 🚀

Creates a batch job using OpenAI's Batch API - **50% cheaper** and no rate limits!

**Usage:**

```bash
bun run scripts/batch-identify-solar-panels.ts
```

**What it does:**

- Finds completed applications missing tagged solar panel pictures
- Creates batch job for all after-install images (excluding HEIC)
- Uploads to OpenAI Batch API

**Output:**

- Batch ID for tracking
- Estimated cost (50% cheaper than real-time)
- Saves batch info JSON for later retrieval

**Requirements:**

- `OPENAI_API_KEY` environment variable

---

### `check-batch-status.ts` - Check Batch Status

Monitor the progress of your batch job.

**Usage:**

```bash
bun run scripts/check-batch-status.ts <batch_id>
```

**Output:**

- Current status (validating, in_progress, completed, failed)
- Request counts (total, completed, failed)
- Duration and timestamps

**Example:**

```bash
bun run scripts/check-batch-status.ts batch_abc123xyz
```

---

### `retrieve-batch-results.ts` - Get Results & Update DB

Retrieves completed batch results and automatically tags the best pictures.

**Usage:**

```bash
bun run scripts/retrieve-batch-results.ts <batch_id>
```

**What it does:**

- Downloads batch results from OpenAI
- Groups results by application
- Tags top 3 pictures per application (sorted by AI confidence)
- Updates `Documents.isShowingSolarPanels = true` in database

**Output:**

- Summary statistics
- Detailed JSON results file: `solar-panels-results-<batch_id>.json`
- Cleanup of temporary batch info files

---

### `fetch-applications-missing-solar-panel-pictures.ts` (Legacy)

⚠️ **Not recommended** - Use batch processing instead to avoid rate limits.

Real-time processing that analyzes images one by one (slower, rate limited, expensive).

**Usage:**

```bash
bun run scripts/fetch-applications-missing-solar-panel-pictures.ts
```

**Limitations:**

- Rate limited by OpenAI
- Processes only first 3 images per application
- 2x more expensive than batch API

---

## Project Quotes

Tools for testing, debugging, and regenerating project quotes.

### `test-quote-api-with-wallet.ts` - Partner Integration Example

Reference implementation for partners integrating with the Glow quotes API using wallet signature authentication.

**Usage:**

```bash
bun run scripts/test-quote-api-with-wallet.ts
```

**What it does:**

- Creates a signed project quote request
- Demonstrates wallet signature authentication
- Shows complete request/response flow

**Environment Variables:**

- `TEST_WALLET_PRIVATE_KEY` - Required (wallet used to sign requests)
- `API_URL` - Optional (defaults to production)

**Important Notes:**

- Create a Hub account first at https://hub.glow.org/login with the same wallet
- Test on staging before production
- Rate limit: 100 quotes per hour (global)

**Environments:**

- Staging: `https://gca-crm-backend-staging.up.railway.app`
- Production: `https://gca-crm-backend-production-1f2a.up.railway.app`

---

### `rerun-all-quotes.ts` - Regenerate Quotes

Re-extracts electricity prices and recomputes all quotes with updated logic.

**Usage:**

```bash
# Dry run (no database changes)
bun run scripts/rerun-all-quotes.ts --dry-run

# Process specific quote
bun run scripts/rerun-all-quotes.ts --id <quote_id>

# Process first N quotes
bun run scripts/rerun-all-quotes.ts --limit=10

# Live mode (saves to database)
bun run scripts/rerun-all-quotes.ts
```

**What it does:**

- Downloads utility bills from R2 storage
- Re-extracts electricity price using AI
- Recomputes protocol deposit and carbon metrics
- Updates database with new values

**Use cases:**

- Algorithm updates
- Price extraction improvements
- Data quality fixes

---

### `fix-watts-to-kw.ts` - Fix Unit Conversion Errors

Identifies and fixes quotes where system size was input in watts instead of kilowatts.

**Usage:**

```bash
# Dry run
bun run scripts/fix-watts-to-kw.ts --dry-run

# Fix for real
bun run scripts/fix-watts-to-kw.ts
```

**What it does:**

- Finds quotes with `netWeeklyCc = 0` and `systemSizeKw > 100`
- Converts watts to kW (divides by 1000)
- Recomputes all quote metrics

**Heuristic:**

- Residential systems: 3-25 kW typical
- System > 100 kW + zero carbon credits = likely watts mistake

---

## Impact Leaderboard & Performance

Performance testing and debugging tools for the impact scoring system.

### `debug-impact-leaderboard.ts` - Performance Benchmark

End-to-end latency measurement for `/impact/glow-score` endpoint.

**Usage:**

```bash
# Test locally
bun run scripts/debug-impact-leaderboard.ts --baseUrl http://localhost:3005 --limit 200 --repeat 5

# Test production
bun run scripts/debug-impact-leaderboard.ts --limit 1000 --warmup 1 --repeat 3

# Custom week range
bun run scripts/debug-impact-leaderboard.ts --startWeek 100 --endWeek 110
```

**Parameters:**

- `--baseUrl` - API base URL (default: localhost:3005)
- `--limit` - Number of wallets to return (default: 50)
- `--startWeek` / `--endWeek` - Custom week range
- `--warmup` - Warmup requests before measurement (default: 1)
- `--repeat` - Number of measurement runs (default: 3)
- `--debugTimings` - Enable server-side timing logs (default: true)

**Output:**

- Min, P50, P95, Max response times
- Server-side timing breakdowns (if logs accessible)
- Week range and wallet counts

**Target Performance:**

- P50 < 500ms
- P95 < 1000ms

---

### `impact-score.ts` - Compute Impact Score for Wallet

Standalone script to compute impact score for a specific wallet with detailed breakdown.

**Usage:**

```bash
# Default week range
bun run scripts/impact-score.ts 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb

# Custom week range
bun run scripts/impact-score.ts 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb --startWeek=97 --endWeek=107
```

**Output:**

- Total points breakdown (rollover, continuous, inflation, steering, vault bonus)
- Glow Worth (liquid GLW, delegated active, unclaimed rewards)
- Full JSON response (same as API)

**Use case:** Debug specific wallet scores or validate calculations.

---

## Rewards & GLW Debugging

Debug tools for GLW rewards calculations, delegation, and unclaimed balances.

### `debug-total-actively-delegated.ts` - Total Actively Delegated GLW Comparison

Compares two different methods for calculating total actively delegated GLW across all wallets.

**Usage:**

```bash
bun run scripts/debug-total-actively-delegated.ts
```

**What it compares:**

- **Method 1 (Fractions):** Sum of historical GLW purchase amounts from launchpad fractions
- **Method 2 (Vault Ownership):** Current vault ownership share of remaining GLW protocol-deposit principal

**Output:**

- Total GLW from each method
- Top 10 delegators by vault ownership
- Explanation of differences
- Why Method 2 is correct for "actively delegated" metrics

**Use case:** Debug why `/fractions/total-actively-delegated` gives different numbers than the delegators leaderboard. The leaderboard uses Method 2 (vault ownership) which accounts for protocol deposit distributions over time.

**Environment:**

- `PG_DATABASE_URL` - Database connection
- `CONTROL_API_URL` - Glow Control API

---

### `debug-delegated-active-glw.ts` - Delegated Active GLW Breakdown

Explains how `delegatedActiveGlwWei` is computed for a wallet under the vault-ownership model.

**Usage:**

```bash
# Full analysis
bun run scripts/debug-delegated-active-glw.ts --wallet 0x... --endWeek 111

# Only farm data (faster, skips wallet rewards API)
bun run scripts/debug-delegated-active-glw.ts --wallet 0x... --endWeek 111 --farmsOnly

# Show top 50 farms
bun run scripts/debug-delegated-active-glw.ts --wallet 0x... --top 50
```

**What it shows:**

- GLW principal paid per farm (sum of GLW applications)
- Protocol deposit rewards distributed per farm
- Wallet's deposit split percentage (vault ownership)
- Active share remaining (principal - distributed) × split%

**Use case:** Diagnose why delegated active GLW is lower/higher than expected.

**Environment:**

- `PG_DATABASE_URL` - Database connection
- `CONTROL_API_URL` - Glow Control API
- `MAINNET_RPC_URL` - Ethereum RPC

---

### `debug-delegators-glw-per-week.ts` - Delegators GLW Per Week

Diagnoses why `glwPerWeekWei` shows as 0 in the delegators leaderboard.

**Usage:**

```bash
# Default (localhost, limit 10)
bun run scripts/debug-delegators-glw-per-week.ts

# Production with more wallets
bun run scripts/debug-delegators-glw-per-week.ts --baseUrl https://gca-crm-backend-production-1f2a.up.railway.app --limit 50
```

**What it checks:**

- Week range used by API
- Total wallets with zero vs non-zero `glwPerWeekWei`
- Sample wallet data
- Computed frontend metric (GLW per week per 100 delegated)

**Common issue:** Control API doesn't have finalized rewards for the current week yet (GCA reports generated Thursdays).

---

### `debug-glow-worth-unclaimed.ts` - Unclaimed GLW Rewards

Traces why `unclaimedGlwRewardsWei` is 0 for a wallet by reconstructing the full claim history.

**Usage:**

```bash
CONTROL_API_URL=<url> bun run scripts/debug-glow-worth-unclaimed.ts --wallet 0x...

# Optional overrides
API_URL=http://localhost:3005 CLAIMS_API_BASE_URL=<ponder-url> bun run scripts/debug-glow-worth-unclaimed.ts --wallet 0x... --startWeek 97 --endWeek 111
```

**What it does:**

- Fetches weekly rewards from Control API (inflation + PD)
- Fetches claim history from Ponder indexer
- Maps claims to weeks using nonce (PD) or amount matching (inflation)
- Computes historical unclaimed balance per week

**Output:**

- Backend `/impact/glow-worth` comparison
- Detected claims (PD via nonce, inflation via amount)
- Historical unclaimed ledger by week
- Current snapshot totals

**Note:** Uses timestamp-based claim detection to show _what was unclaimed at each historical week_.

**Environment:**

- `CONTROL_API_URL` - Required
- `API_URL` - Optional (backend API)
- `CLAIMS_API_BASE_URL` - Optional (Ponder indexer)

---

### `debug-week-107-unclaimed.ts` - Week 107 Unclaimed Trace

Specific diagnostic for Week 107 unclaimed GLW discrepancy (18,761 vs ~9,691 GLW).

**Usage:**

```bash
CONTROL_API_URL=https://api-prod-34ce.up.railway.app bun run scripts/debug-week-107-unclaimed.ts
```

**What it does:**

- Fetches rewards for specific wallet (hardcoded: `0x77f41144e787cb8cd29a37413a71f53f92ee050c`)
- Shows inflation by week (claimable 3 weeks after earning)
- Shows PD by week (claimable 4 weeks after earning)
- Maps claims to weeks
- Calculates what _was_ unclaimed at Week 107 end

**Output:**

- Inflation/PD breakdown with claimability status
- Claim timestamps relative to Week 107 end
- Historical unclaimed calculation
- Gap analysis

**Use case:** One-off debug for specific discrepancy.

---

## Referral System

### `backfill-referral-codes.ts` - Generate Referral Codes

Generates unique referral codes and shareable links for all existing wallets.

**Usage:**

```bash
# Dry run
bun run scripts/backfill-referral-codes.ts --dry-run

# For real
bun run scripts/backfill-referral-codes.ts
```

---

### `debug-referral-pending.ts` - Pending Points Projection Debug

Explains why a pending referral shows `0` projected points (tier gating, projection base points, proration, activation threshold).

**Usage:**

```bash
bun run scripts/debug-referral-pending.ts --referee 0x5e230fed487c86b90f6508104149f087d9b1b0a7

# Optional: override referrer wallet
bun run scripts/debug-referral-pending.ts --referee 0x... --referrer 0x...
```

**Output includes:**

- Referrer base points (for tier gating)
- Active referee count + tier percent used
- Referee projected base points (raw + prorated)
- Post-link base points vs activation threshold
- Pending share (active-only vs including pending vs if activation happens this week)

---

### `debug-referral-new-users.ts` - New Referral Users With Points

Finds referees who had **0 base points last completed week** but have **non-zero points this week**, and prints the projected point source breakdown (inflation / steering / vault / worth).

**Usage:**

```bash
# Basic
bun run scripts/debug-referral-new-users.ts

# Limit output rows + control concurrency
bun run scripts/debug-referral-new-users.ts --limit 25 --concurrency 4

# Only include referees with >1.0 projected points (scaled6)
bun run scripts/debug-referral-new-users.ts --minPoints 1.000000
```

**Output includes:**

- Referee + referrer wallet
- Linked timestamp
- Last week base points
- Current week projected base points
- Points breakdown by source

---

## Solar Collector Debugging & Diagnostics

### `debug-solar-collector.ts` - Solar Collector Stats Investigation

Investigates why `/solar-collector/stats` returns 0 watts for a wallet while `/impact/delegators-leaderboard` shows the wallet has impact score.

**Usage:**

```bash
bun run scripts/debug-solar-collector.ts --wallet 0x77f41144E787CB8Cd29A37413A71F53f92ee050C
```

**What it checks:**

1. `/solar-collector/stats` - totalWatts, panels, ghostProgress, streak
2. `/impact/delegators-leaderboard` - Searches for wallet in top 500
3. `/impact/glow-score` - Gets wallet's impact score with weekly breakdown
4. Cross-references finalized farms

---

### `debug-watts-by-week.ts` - Regional Watts Verification

Verifies the watts distribution for a specific wallet in a specific region (default: Colorado).

**Usage:**

```bash
bun run scripts/debug-watts-by-week.ts <walletAddress> [regionId]
```

**Output:**

- User share percentage per week
- Farm-by-farm breakdown of captured watts
- Comparison against regional power cache

---

### `debug-farm-watts-distribution.ts` - Farm Level Breakdown

Shows how watts from a single farm were distributed across the entire network.

**Usage:**

```bash
bun run scripts/debug-farm-watts-distribution.ts <farmId>
```

---

### `generate-impact-diagnostics.ts` - Data Export for Visualization

Generates a comprehensive `solar_footprint_data.json` file containing full weekly power history and farm capture details.

**Usage:**

```bash
bun run scripts/generate-impact-diagnostics.ts <walletAddress>
```

**Use Case:** Prepares data for Python visualization scripts (`visualize_points.py`, `visualize_footprint.py`).

---

### `backfill-weekly-power.ts` - Historical Data Migration

Backfills the `power_by_region_by_week` table with historical data from Week 97 onwards.

**Usage:**

```bash
bun run scripts/backfill-weekly-power.ts
```

---

### `backfill-all-caches.ts` - Backfill All Caches at Once

Runs all cache backfills sequentially and exits when complete. Useful for initial setup or after schema changes.

**Usage:**

```bash
bun run scripts/backfill-all-caches.ts
```

**What it backfills (in order):**

1. **Weekly Power by Region** - `power_by_region_by_week` table (weeks 97 to current-1)
2. **Impact Leaderboard (global)** - `impact_leaderboard_cache` table
3. **Impact Leaderboard by Region** - `impact_leaderboard_cache_by_region` table

**Output:**

- Progress for each cache
- Summary with row counts and timing
- Exits with code 0 on success, 1 on failure

**Example output:**

```
🚀 Starting backfill of ALL caches...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣  Weekly Power by Region
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Week range: 97 → 110
   ✅ Updated 1500 rows in 12.3s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2️⃣  Impact Leaderboard (global)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✅ Updated 850 rows in 45.2s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3️⃣  Impact Leaderboard by Region
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✅ Updated 2100 rows in 38.7s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Weekly Power: 1500 rows (12.3s)
   Impact Leaderboard: 850 rows (45.2s)
   Impact by Region: 2100 rows (38.7s)
──────────────────────────────────────────────────
   TOTAL: 4450 rows in 96.2s

✅ All caches backfilled successfully!
```

---

## Utilities

### `get-farm-name-by-application-id.ts` - Get Farm Name

Simple lookup tool to find the farm name for a given application ID.

**Usage:**

```bash
bun run scripts/get-farm-name-by-application-id.ts <application_id>
```

**Output:**

- Farm name (or deterministic star name fallback)

**Example:**

```bash
bun run scripts/get-farm-name-by-application-id.ts clv5lf6ha0000mkq3dbnqddwb
# Farm Name: Sunrise Solar Farm
```

---

### `move-applications-to-zone.ts` - Move Applications to Another Zone

Moves a list of applications (and their associated farms, if any) to a different zone.

**Usage:**

```bash
# Dry run (default) - preview changes without modifying the database
bun run scripts/move-applications-to-zone.ts

# Execute for real
bun run scripts/move-applications-to-zone.ts --execute
```

**Configuration:**

Edit the script to set your target zone and application IDs:

```typescript
const TARGET_ZONE_ID = 8; // Oklahoma

const APPLICATION_IDS = [
  "3c8a504d-64e1-4dca-b747-34fd438fa339",
  "52069f39-ff18-43b1-acbf-1c42e0a3fcd6",
  // ... add more application IDs
];
```

**What it does:**

1. Verifies the target zone exists and shows its details
2. Fetches all specified applications with their current zone info
3. Displays a table showing current state and planned changes
4. Updates `applications.zoneId` and `applications.updatedAt`
5. Updates `farms.zoneId` for any applications that have associated farms

**Output:**

- Current zone and status for each application
- List of applications that would be/were updated
- Warning for any application IDs not found in the database

**Example output:**

```
Application ID                           | Current Zone       | Status              | Has Farm | Owner
─────────────────────────────────────────────────────────────────────────────────────────────────────
3c8a504d-64e1-4dca-b747-34fd438fa339 | Clean Grid Project | waiting-for-approval | No       | John Doe
                                         | → Noble Oklahoma
```

---

## Common Patterns

### Environment Variables

Most scripts use these standard environment variables:

```bash
# Database
PG_DATABASE_URL=postgresql://...

# APIs
CONTROL_API_URL=https://api-prod-34ce.up.railway.app
API_URL=http://localhost:3005
CLAIMS_API_BASE_URL=https://glow-ponder-listener-2-production.up.railway.app
MAINNET_RPC_URL=https://...

# OpenAI
OPENAI_API_KEY=sk-...

# Testing
TEST_WALLET_PRIVATE_KEY=0x...
```

### Dry Run Mode

Many scripts support `--dry-run` to preview changes without modifying the database:

```bash
bun run scripts/rerun-all-quotes.ts --dry-run
bun run scripts/fix-watts-to-kw.ts --dry-run
```

### Performance Testing

Follow this pattern for performance validation:

1. **Benchmark**: `bun run scripts/debug-impact-leaderboard.ts --repeat 5`
2. **Apply fixes** (migrations, code changes)
3. **Re-benchmark** and compare

---

## Troubleshooting

### "OPENAI_API_KEY not found"

Add to your `.env` file:

```bash
OPENAI_API_KEY=sk-proj-...
```

### "CONTROL_API_URL not configured"

Set the environment variable:

```bash
export CONTROL_API_URL=https://api-prod-34ce.up.railway.app
```

### Rate Limits

- **OpenAI Batch API**: No rate limits (preferred)
- **OpenAI Real-time API**: Rate limited (use batch instead)
- **Quotes API**: 100 quotes/hour globally

### Slow Performance

1. Trigger cache refresh: `curl <API_URL>/trigger-impact-leaderboard-cron`
2. Check database indexes in `src/db/schema.ts`
3. Run performance test: `bun run scripts/debug-impact-leaderboard.ts`

---

## Related Documentation

- [Impact Router README](../src/routers/impact-router/README.md)
- [Control API Documentation](../src/routers/impact-router/helpers/control-api.ts)
- [Weekly Reports](../../glow-utils/src/lib/create-weekly-report/)
