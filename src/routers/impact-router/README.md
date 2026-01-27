# Impact Router

Public endpoints for **Glow Worth** and **Glow Impact Score**.

This is a **status-only leaderboard** (no monetary rewards are paid out by this API). The router exposes data to explain _why_ a wallet ranks where it does, and its “live” potential if it acts now.

## Concepts

### Glow Worth

\[
\\text{GlowWorth} = \\text{LiquidGLW} + \\text{DelegatedActiveGLW} + \\text{UnclaimedGLWRewards} + \\text{RecoveredButNotClaimable}
\]

- `LiquidGLW`: on-chain ERC20 GLW `balanceOf(wallet)` (18 decimals / wei)
- `DelegatedActiveGLW`: the wallet’s **vault ownership** share of remaining **GLW protocol-deposit principal**, modeled as:
  - For each farm \(f\):
    - `principalPaidGlwWei(f)`: the farm’s GLW protocol deposit principal from `applications.paymentAmount` where `paymentCurrency=GLW` and `status=completed`
    - `distributedGlwWeiToWeek(f, week)`: cumulative `protocolDepositRewardsDistributed` from Control API farm weekly rewards where `paymentCurrency=GLW`
    - `remainingGlwWei(f, week) = max(0, principalPaidGlwWei(f) - distributedGlwWeiToWeek(f, week))`
    - `walletSplit6(f, week)`: the wallet’s `depositSplitPercent6Decimals` ownership at that week (Control API split history; `POST /farms/by-wallet/deposit-splits-history/batch`)
    - `walletShareRemainingGlwWei(f, week) = remainingGlwWei(f, week) * walletSplit6(f, week) / 1_000_000`
  - Then: `DelegatedActiveGLW(week) = sum_farms walletShareRemainingGlwWei(f, week)`
  - Accounting starts at **week 97** (first week vault ownership exists). Even if you query `startWeek > 97`, we compute ownership from week 97 so farm distributions earlier in the range don’t distort `remainingGlwWei`.
  - **Miners** do not participate in protocol-deposit vaults; mining-center `depositSplitPercent6Decimals` is always `0`.
- `DelegatedActiveGLW` **includes** GLW launchpad purchases recorded in `fraction_splits` that are **not yet reflected** in Control API split history for the wallet. This prevents temporary Glow Worth dips when GLW moves from the wallet into the vault before the split history is updated.
- **Unfinalized week handling (report lag):**
  - We treat the **last finalized week** as the latest week with complete Control API rewards (per Thursday 00:00 UTC schedule).
  - For any week **after** the finalized week:
    - **Protocol-deposit recovery is not applied yet** (so delegatedActive is not reduced).
    - **Liquid GLW uses live on-chain balance** if the weekly snapshot is not available (forward-filled/current), to avoid mixing stale snapshots with updated delegation splits.
  - Once the week finalizes, both recovery and liquid snapshots are allowed to update normally.
- `UnclaimedGLWRewards`: claimable rewards minus claims (see details below)
- `RecoveredButNotClaimable`: protocol-deposit recovery already earned at the farm level but still within the 4-week claim delay (so it has not moved into `UnclaimedGLWRewards` yet). This prevents temporary dips when principal recovery is recognized before it becomes claimable.

### Glow Impact Score

For each week in the requested week range, we compute:

- **Base points** (calculated per week):
  - Emissions earned: **+1.0** point per **GLW** earned in emission rewards
  - Steering (sGCTL): **+3.0** points per **GLW** steered by staking GCTL
  - Vault bonus (delegated GLW): **+0.005** points per week per **GLW** in `DelegatedActiveGLW`
  - GLW Worth: **+0.001** points per week per **GLW** of `GlowWorth` for that week
- **Weekly multiplier** (calculated and applied on week rollover):
  - Total multiplier = **Base multiplier + Streak bonus**
  - Base multiplier:
    - Standard: **1×**
    - Cash miner bonus: **3×** if the wallet bought a mining-center fraction that week
  - Streak bonus (Impact Streak):
    - Earn **+0.25×** for every consecutive week you **increase your delegated GLW** (net delegation delta > 0 for that week) **or** **buy a miner**
    - Caps at **+1.0×** (after 4 consecutive weeks)
    - Resets to **0×** if you do neither in a week
  - **The multiplier is applied to ALL base points** (Emissions, Steering, Vault, AND Glow Worth)

**Final Score Formula:**

```
TotalPoints = (Emissions + Steering + Vault + GlowWorth) × Multiplier + ReferralPoints + ReferralBonusPoints + ActivationBonus
```

Where:
- `ReferralPoints`: sum of tiered % shares from all active referees (for referrers)
- `ReferralBonusPoints`: 10% of own base points if within 12-week bonus period (for referees)
- `ActivationBonus`: 100 points one-time when referee reaches 100 total points

All points are computed internally with **6-decimal fixed-point precision** and returned as strings.

### Referral Network Tiers (Referrer)

Referrers earn a percentage of their referees' **base points** (pre-multiplier) based on their active network size:

| Tier | Active Referrals | Referrer Earns |
| :--- | :--- | :--- |
| **Seed** | 1 | 5% |
| **Grow** | 2–3 | 10% |
| **Scale** | 4–6 | 15% |
| **Legend** | 7+ | 20% |

- Referral points are **not subject to multipliers** (neither referrer's nor referee's).
- Referrals activate once the referee earns ≥100 total Impact Points.

### Referral Bonus (Referee)

Referees earn bonuses for joining via a referral link:
- **+10% Bonus**: On their own base points for 12 weeks.
- **+100pt Activation Bonus**: One-time award when they first reach 100 total Impact Points.

### Regional Breakdown

The `regionBreakdown` field (returned for single-wallet queries) shows how a user's points are distributed across regions. Points are categorized as:

- **Direct Points** (`directPoints`): Points from active participation - inflation rewards, GCTL steering, and vault bonus. Only regions where the user actively participated will have non-zero direct points.

- **Glow Worth Points** (`glowWorthPoints`): Points from passive GLW ownership. Unlike direct points, Glow Worth is distributed proportionally across **ALL regions with emissions**, not just regions where the user has direct activity.

**Why Glow Worth spans all regions:**

Glow Worth represents passive ownership from holding GLW tokens. The value of that GLW is tied to the entire protocol's emissions across all regions. A user holding 1M GLW earns worth points from every active region, even if they never staked GCTL or delegated to farms there.

**Formula:**

\[
\text{glowWorthPoints}[\text{region}] = \text{totalGlowWorth} \times \frac{\text{regionEmissions}}{\text{totalEmissions}}
\]

**Implications for `regionBreakdown`:**

- Regions may appear with `directPoints: "0.000000"` but non-zero `glowWorthPoints` - this is intentional and accurate
- The sum of all regional `glowWorthPoints` equals the wallet's total worth points (after multiplier)
- The sum of all regional `directPoints` equals the wallet's total direct points (Emissions + Steering + Vault, after multiplier)
- **Both `directPoints` and `glowWorthPoints` in regional breakdown are post-multiplier values**

**Delegated GLW in regional breakdown:**

Delegated GLW intentionally contributes to both point categories (but at different rates):

1. **Vault bonus (0.005/GLW)** → appears in `directPoints`, attributed to the specific farm's region
2. **GLW Worth (0.001/GLW)** → appears in `glowWorthPoints`, distributed by emission share (since delegated GLW is part of total GlowWorth)

This matches the totals formula where delegated GLW earns both vault bonus AND contributes to GLW Worth.

## Leaderboard timing: “do I move up instantly?”

### What updates instantly (next fetch)

If you **buy/receive GLW now**, the score can change, but it no longer “backfills” the entire history range for liquid balance. The scoring model now uses **end-of-week balance snapshots** for `LiquidGLW`, so a brief spike in balance only affects the weeks where you actually held it.

- `GET /impact/glow-worth` uses on-chain `balanceOf(wallet)` for **current** `LiquidGLW`. Weekly history still applies the finalized-week freeze rule described above.
- The score includes **continuous points** based on `GlowWorth` for each week in the requested range. For those computations, `LiquidGLW` uses **weekly end-of-week balance snapshots** (ponder-indexed) rather than the current `balanceOf` snapshot.
  - This still includes **swaps**, since swaps move GLW via standard ERC20 `Transfer` events and are reflected in snapshots.

### What does _not_ update instantly

The **weekly rollover components** (inflation / steering / vault bonus / cash-miner multiplier) are derived from **weekNumber-indexed** data sources and behave like weekly accounting:

- Inflation + protocol-deposit recovery come from Control API reward history (by `weekNumber`)
- Steering is derived from Control API **epoch-specific** region rewards and **stake-by-epoch** snapshots; if those endpoints are unavailable, the backend falls back to the **current stake snapshot** method (applied uniformly across the queried week range)
- Cash-miner bonus depends on whether a mining-center fraction purchase happened in a given `weekNumber`

So buying GLW does **not** retroactively change those weekly rollover rows.

### Default week cutoff nuance

By default, `startWeek/endWeek` use `getWeekRangeForImpact()`:

- `startWeek`: fixed start (currently `97`)
- `endWeek`: the **last completed protocol week** (based on actual protocol week boundaries: Sunday 00:00 UTC rollover from GENESIS_TIMESTAMP), not "the in-progress current protocol week".

**Important**: This is different from `getWeekRange()` used by fractions/rewards, which uses Thursday 00:00 UTC GCA report timing. Impact scoring can use more recent weeks because snapshot/claims data is available immediately after the protocol week ends, whereas GCA reports need additional processing time.

If you pass explicit `startWeek/endWeek` query params, the backend will compute over that range (it only validates `endWeek >= startWeek`).

## Frontend usage (how to call these endpoints)

These are **public HTTP endpoints** exposed by `impactRouter` (Elysia) under the `/impact` prefix. From a frontend, you just `fetch()` them.

### Base URL

- **Local dev**: `http://localhost:3005`
- **Prod**: your deployed backend origin (e.g. `https://api.yourdomain.com`)

### Important response/typing notes

- **All numeric fields are returned as strings** (including `...Wei` and points like `"293.854627"`).
- **Do not use `Number()` for wei values** (can overflow). Use `BigInt` + `formatUnits`.
- **Points are already decimal strings** (6-decimal fixed point formatted). Keep them as strings for display, or convert to `Number` only if you accept JS float behavior.

### `GET /impact/glow-worth` (single wallet vs list)

- **Single wallet**: pass `walletAddress` → returns a single `glowWorth` object
- **List**: omit `walletAddress` → returns `{ weekRange, limit, wallets: glowWorth[] }`
- **List (no `limit`)**: when `limit` query param is omitted, response also includes `totalWalletCount` so UIs can show “displaying 200 of N”.

#### List-mode wallet universe (important)

`GET /impact/glow-worth` list mode is **not** “all GLW holders”. Today it only considers wallets already known to the backend via protocol activity (fraction buyers + reward split wallets), and it excludes internal/team wallets via `EXCLUDED_LEADERBOARD_WALLETS`.

Example (Next.js / React server-side fetch):

```ts
import { formatUnits } from "viem";

interface GlowWorthResponse {
  walletAddress: string;
  liquidGlwWei: string;
  delegatedActiveGlwWei: string;
  unclaimedGlwRewardsWei: string;
  glowWorthWei: string;
  dataSources: {
    liquidGlw: string;
    delegatedActiveGlw: string;
    unclaimedGlwRewards: string;
  };
}

export async function getGlowWorth(params: {
  baseUrl: string; // e.g. process.env.NEXT_PUBLIC_BACKEND_URL!
  walletAddress: string;
  startWeek?: number;
  endWeek?: number;
}): Promise<{
  glowWorth: GlowWorthResponse;
  glowWorthGlw: string;
}> {
  const url = new URL("/impact/glow-worth", params.baseUrl);
  url.searchParams.set("walletAddress", params.walletAddress);
  if (params.startWeek != null)
    url.searchParams.set("startWeek", String(params.startWeek));
  if (params.endWeek != null)
    url.searchParams.set("endWeek", String(params.endWeek));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());

  const glowWorth = (await res.json()) as GlowWorthResponse;
  const glowWorthGlw = formatUnits(BigInt(glowWorth.glowWorthWei), 18);

  return { glowWorth, glowWorthGlw };
}
```

### `GET /impact/glow-score` (leaderboard vs full breakdown)

There are two shapes, based on `walletAddress`:

- **Single wallet** (`walletAddress=0x...`): returns `glowWorth`, `totals`, `regionBreakdown`, and `currentWeekProjection` (live preview). **Weekly breakdown is only included when `includeWeekly=1`.**
- **Leaderboard/list** (omit `walletAddress`): returns lightweight rows with totals + a `composition` breakdown + `lastWeekPoints` + `activeMultiplier` (no weekly data).
- **Leaderboard/list**: response includes `totalWalletCount` so UIs can show “displaying 200 of N”.

#### `includeWeekly` (optional)

By default, weekly breakdown is **not** returned. Set `includeWeekly=1` (or `includeWeekly=true`) to include the `weekly[]` array and `pointsPerRegion` breakdown in weekly rows.

#### Leaderboard eligibility (who can show up?)

The leaderboard is **not** limited to "protocol participants" anymore. In list mode, the backend builds an eligible wallet universe from:

- **All GLW holders** (ponder listener `glowBalances` where balance > 0)
- **All wallets with staked GCTL** (Control API `wallets.stakedControl > 0`)
- **Protocol wallets** already known to the backend (fraction buyers + reward split wallets)

**Exclusions**:

- Internal/team wallets (via `EXCLUDED_LEADERBOARD_WALLETS` list)
- Excluded wallets are also filtered out of **region cache** and **weekly power** snapshots, so they will not appear in Solar Collector watts.
- **Wallets with < 0.01 points** - To avoid confusion and clutter from dust wallets, wallets below this threshold are excluded. This filters out:
  - Wallets with 0 points (no historical contribution yet, typically acquired GLW during current ongoing week)
  - Dust wallets with negligible amounts (< 0.01 GLW worth over the entire period)
  - Approximately 86 wallets out of 922 are excluded for this reason
  - Excluded wallets will appear once they accumulate >= 0.01 points in completed weeks

#### Leaderboard output vs eligibility (why `totalWalletCount` can be > returned rows)

- `totalWalletCount` refers to the **eligible wallet universe** (after excluding internal/team wallets).
- To keep latency reasonable, list mode may compute scores over a **candidate subset** (protocol wallets + all GCTL stakers + top GLW holders by balance) and return the top `limit` rows from that scored set.

#### Full breakdown for a single wallet

Example:

```ts
import { formatUnits } from "viem";

interface ImpactScoreTotals {
  totalPoints: string;
  rolloverPoints: string;
  continuousPoints: string;
  inflationPoints: string;
  steeringPoints: string;
  vaultBonusPoints: string;
  totalInflationGlwWei: string;
  totalSteeringGlwWei: string;
}

interface ImpactScoreWeeklyRow {
  weekNumber: number;
  inflationGlwWei: string;
  steeringGlwWei: string;
  delegatedActiveGlwWei: string;
  protocolDepositRecoveredGlwWei: string;
  inflationPoints: string;
  steeringPoints: string;
  vaultBonusPoints: string;
  rolloverPointsPreMultiplier: string;
  rolloverMultiplier: number;
  rolloverPoints: string;
  glowWorthGlwWei: string;
  continuousPoints: string;
  totalPoints: string;
  hasCashMinerBonus: boolean;
}

interface ImpactScoreResponse {
  walletAddress: string;
  weekRange: { startWeek: number; endWeek: number };
  glowWorth: GlowWorthResponse;
  totals: ImpactScoreTotals;
  composition: {
    steeringPoints: string;
    inflationPoints: string;
    worthPoints: string;
    vaultPoints: string;
  };
  lastWeekPoints: string;
  activeMultiplier: boolean;
  hasMinerMultiplier: boolean;
  endWeekMultiplier: number;
  weekly: ImpactScoreWeeklyRow[];
  currentWeekProjection: {
    weekNumber: number;
    hasMinerMultiplier: boolean;
    hasSteeringStake: boolean;
    projectedPoints: {
      steeringGlwWei: string;
      inflationGlwWei: string;
      delegatedGlwWei: string;
      glowWorthWei: string;
      totalProjectedScore: string;
    };
  };
}

export async function getImpactScore(params: {
  baseUrl: string;
  walletAddress: string;
  startWeek?: number;
  endWeek?: number;
}): Promise<ImpactScoreResponse & { glowWorthGlw: string }> {
  const url = new URL("/impact/glow-score", params.baseUrl);
  url.searchParams.set("walletAddress", params.walletAddress);
  if (params.startWeek != null)
    url.searchParams.set("startWeek", String(params.startWeek));
  if (params.endWeek != null)
    url.searchParams.set("endWeek", String(params.endWeek));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());

  const data = (await res.json()) as ImpactScoreResponse;
  const glowWorthGlw = formatUnits(BigInt(data.glowWorth.glowWorthWei), 18);
  return { ...data, glowWorthGlw };
}
```

#### Leaderboard/list (no weekly rows)

Example:

```ts
interface ImpactScoreLeaderboardRow {
  walletAddress: string;
  totalPoints: string;
  glowWorthWei: string;
  composition: {
    steeringPoints: string;
    inflationPoints: string;
    worthPoints: string;
    vaultPoints: string;
  };
  // Points earned in the previous week relative to `endWeek` (i.e. weekNumber = endWeek - 1)
  lastWeekPoints: string;
  activeMultiplier: boolean;
  hasMinerMultiplier: boolean;
  hasSteeringStake: boolean;
  hasVaultBonus: boolean;
  endWeekMultiplier: number;
  // Stable rank by totalPoints (descending) for the scored candidate set.
  // This does NOT change when you sort by lastWeekPoints or glowWorth.
  globalRank: number;
  // rankDelta?: number; // intentionally omitted today (expensive to compute)
}

interface ImpactScoreLeaderboardResponse {
  weekRange: { startWeek: number; endWeek: number };
  limit: number;
  totalWalletCount?: number;
  wallets: ImpactScoreLeaderboardRow[];
}

export async function getImpactLeaderboard(params: {
  baseUrl: string;
  startWeek?: number;
  endWeek?: number;
  limit?: number;
  sort?: "totalPoints" | "lastWeekPoints" | "glowWorth";
  dir?: "asc" | "desc";
}): Promise<ImpactScoreLeaderboardResponse> {
  const url = new URL("/impact/glow-score", params.baseUrl);
  if (params.startWeek != null)
    url.searchParams.set("startWeek", String(params.startWeek));
  if (params.endWeek != null)
    url.searchParams.set("endWeek", String(params.endWeek));
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.sort != null) url.searchParams.set("sort", params.sort);
  if (params.dir != null) url.searchParams.set("dir", params.dir);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());

  return (await res.json()) as ImpactScoreLeaderboardResponse;
}
```

##### Leaderboard sorting

List mode supports backend-driven sorting:

- `sort`: `totalPoints` (default), `lastWeekPoints`, `glowWorth`
- `dir`: `desc` (default), `asc`

Notes:

- Sorting is applied **before** slicing to `limit`.
- `globalRank` always reflects rank by `totalPoints` **descending** (stable across sorts).

### Performance guidance & caching

#### Database Cache (Leaderboard)

- **Table**: `impact_leaderboard_cache` stores pre-computed leaderboard rows with `startWeek`, `endWeek`, `rank`, and full JSON payload.
- **Indexes**: Composite indexes on `(start_week, end_week, total_points)`, `(start_week, end_week, last_week_points)`, and `(start_week, end_week, glow_worth_wei)` ensure fast sorted queries (~500ms for 225 wallets).
- **Cron**: Weekly on Sunday at 01:00 UTC (`update-impact-leaderboard` cron job) computes scores for ~1000 wallets and atomically replaces the cache.
- **Router**: When a request matches the default week range (from `getWeekRangeForImpact()`), the router serves from the database cache (~500ms response time for production, ~1s for localhost).
- **Cache validation**: The router validates that `actualStartWeek` and `actualEndWeek` match the cached `startWeek` and `endWeek`. If they don't match (e.g., right after a protocol week rollover but before the cron runs), it falls back to on-the-fly computation.
- **Single-wallet queries**: Always bypass the cache and compute on-the-fly to include `currentWeekProjection` (live preview for the ongoing week).
- **Performance**: With indexes (added Jan 2026), leaderboard requests achieve ~500ms P50 latency, a 10x improvement from the previous ~5s response times.

#### In-Memory Cache

- Some Control API calls are cached in-process to reduce repeated work (e.g. region rewards are cached for ~30s, GLW holders for 10 minutes).
- The `/impact/glow-score` **list** response is cached in-memory for ~10 minutes (in addition to the database cache).
- Single-wallet responses are **not** cached in-memory, since `currentWeekProjection` is meant to feel "live".

#### Other Optimizations

- `includeWeekly=true|1` on `/impact/glow-score` can be **very large** when you query many wallets; avoid using it for leaderboard screens.
- For dashboards, fetch a single wallet with `walletAddress` and a bounded `startWeek/endWeek`.
- In list mode, the backend may score a **candidate subset** (e.g. protocol wallets + GCTL stakers + top GLW holders by balance) to keep latency reasonable while still returning the top `limit` by score.

### Profiling / debugging leaderboard latency

`GET /impact/glow-score` supports an on-demand timing log (list mode only):

- Add `debugTimings=true` (or `1`) to emit a single summary log showing which stages are slow.

Performance testing scripts:

```bash
# Test localhost performance
bun run scripts/debug-impact-leaderboard.ts --baseUrl http://localhost:3005 --limit 1000 --repeat 3

# Test production performance
bun run scripts/debug-impact-leaderboard.ts --baseUrl https://gca-crm-backend-production-1f2a.up.railway.app --limit 1000 --repeat 3

# Check cache state
bun run scripts/check-impact-cache-state.ts
```

**Expected performance (with indexes)**:

- Production: P50 ~500ms, P95 ~500ms
- Localhost: P50 ~1000ms, P95 ~1000ms

## `GET /impact/glow-worth`

Computes the wallet's GLW-denominated position:

- `GlowWorth = LiquidGLW + DelegatedActiveGLW + UnclaimedGLWRewards`
- `LiquidGLW`: onchain ERC20 GLW `balanceOf` via `viem`
- `DelegatedActiveGLW`: launchpad GLW delegated minus protocol-deposit rewards received (converted to GLW using current spot price)
- `UnclaimedGLWRewards`: computed as:
  - **Claimable GLW** from Control API weekly rewards (`/wallets/address/:wallet/weekly-rewards?paymentCurrency=GLW&limit=520`)
    - When `paymentCurrency=GLW`, both:
      - `glowInflationTotal`
      - `protocolDepositRewardsReceived`
        are **GLW-denominated** (18-decimal wei).
  - We only treat weeks as claimable once they’re finalized (matches wallet claims UX):
    - GLW inflation finalizes after **3** weeks
    - protocol-deposit payouts finalize after **4** weeks
    - so the effective claimable cutoff is `min(currentEpoch - 3, currentEpoch - 4)`
  - **Claimed GLW** is derived from the claims API (`/rewards/claims/:address`) by filtering:
    - `token == 0xf4fbc617a5733eaaf9af08e1ab816b103388d8b6` (GLW)
  - Claims are attributed to the **reward week** (not the claim timestamp):
    - **RewardsKernel** claims include `nonce` → week mapping (v2 nonce 0 corresponds to week 97): `week = 97 + nonce`
    - **MinerPool** claims are indexed from GLW `Transfer` logs and do not include a week; we infer the reward week by matching the claim `amount` to the Control API `glowInflationTotal` for that week (with a 10M wei epsilon to tolerate downstream rounding)
  - **All wallets** now use "accurate" mode (both single wallet and leaderboard). The leaderboard performance is maintained by caching the results daily in `impact_leaderboard_cache` table.

Query:

- `walletAddress` (optional): when omitted returns up to `limit` wallets
- `startWeek`, `endWeek` (optional): used for week-bounded computations
- `limit` (optional): default `200`

## `GET /impact/glow-score`

Computes Glow Impact Score using:

- Weekly rollover points (inflation + steering + vault bonus), with cash-miner multiplier
- Continuous points based on Glow Worth (per-week rate), summed over the queried week range

Notes:

- **Steering (GCTL → “GLW steered”)**:
  - Uses epoch-specific region reward distribution from Control API: `GET /regions/rewards/glw/regions?epoch=<week>`
  - Uses epoch-specific wallet per-region stake snapshots from Control API: `GET /wallets/address/:wallet/stake-by-epoch?startEpoch=<start>&endEpoch=<end>`
  - For each week/epoch and each region, compute wallet share:
    - `walletShare = walletRegionStakeWei / regionTotalStakeWei`
    - `walletSteeredGlwWei = regionGlwRewardWei * walletShare`
  - Sum across regions to get `steeringGlwWei` for that week.
  - If these Control API endpoints are unavailable, the backend falls back to the **current stake snapshot** method.
- **Unclaimed rewards**:
  - Derived from Control API weekly rewards minus claim rows fetched from the claims API (`https://glow-ponder-listener-2-production.up.railway.app`).
  - **Historical accuracy**: Uses claim timestamps to determine if a reward was unclaimed "at the end of week W". If `claimTimestamp > weekEndTimestamp`, the reward counts as unclaimed for that week.
  - **V1/V2 boundary**: Claims that occurred before Week 97 started (timestamp < 1759104000) are filtered out, even if they have v2-compatible nonces.
  - **Inflation claim inference**: MinerPool claims (which lack nonces) are attributed to weeks by matching the transfer amount to Control API's `glowInflationTotal` for each week (within 10M wei epsilon). Ambiguous matches are rejected.

Query:

- `walletAddress` (optional): when provided returns full weekly breakdown
- `startWeek`, `endWeek` (optional)
- `limit` (optional): default `200`
- `includeWeekly` (optional): `true|1` to include weekly rows when querying multiple wallets (can be large)

## UI Indicator Behavior (Current vs Finalized)

The frontend displays multipliers/bonuses differently based on context:

### Single Wallet View (Rank Widget, Wallet Dashboard)

- **Purpose**: Show what's ACTIVE NOW for the current ongoing week
- **Data Source**: `currentWeekProjection` from single-wallet API response
- **Fields**:
  - `hasMinerMultiplier` - Did you buy a miner THIS week?
  - `hasSteeringStake` - Do you have GCTL staked NOW?
  - `streakBonusMultiplier` - What's your current streak bonus?
- **Why**: Users want to see "what bonuses am I getting RIGHT NOW" to decide whether to take action

### Leaderboard View (Global Leaderboard Table & Breakdown)

- **Purpose**: Show FINALIZED multipliers/bonuses that were used to calculate the displayed score
- **Data Source**: Fields from the last completed week (`endWeek`)
- **Fields**:
  - `hasMinerMultiplier` - Did they have a miner at `endWeek`?
  - `endWeekMultiplier` - What was their total multiplier at `endWeek`?
  - `hasSteeringStake` - Did they steer GLW during the scored period? (derived from `totals.totalSteeringGlwWei > 0`)
  - `hasVaultBonus` - Do they have delegations? (derived from `glowWorth.delegatedActiveGlwWei > 0`)
- **Why**: The leaderboard shows historical scores, so indicators should reflect the state that produced those points. If someone stakes GCTL today, it shouldn't light up the "steering" indicator on the leaderboard until next week's rollover.
- **Breakdown Dialog**: When opened from the leaderboard, pass `showCurrentWeekProjection={false}` to hide current week projection and only show finalized data.

## Cache Management

### Manual Cache Refresh

You can manually trigger the impact leaderboard cache update (useful for testing or forcing a refresh):

```bash
curl http://localhost:3005/trigger-impact-leaderboard-cron
# Returns: {"message":"success"}
```

This endpoint triggers the same cron job that runs weekly on Sunday at 01:00 UTC. The update typically takes 20-30 seconds for ~1000 wallets.

### Cache Table Schema

```sql
CREATE TABLE impact_leaderboard_cache (
  wallet_address VARCHAR(42) PRIMARY KEY,
  total_points NUMERIC(20,6) NOT NULL,
  rank INTEGER NOT NULL,
  glow_worth_wei NUMERIC(78,0) NOT NULL,
  last_week_points NUMERIC(20,6) NOT NULL,
  start_week INTEGER NOT NULL,
  end_week INTEGER NOT NULL,
  data JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Composite indexes for fast sorted queries (added Jan 2026)
CREATE INDEX impact_cache_week_total_points_idx
  ON impact_leaderboard_cache (start_week, end_week, total_points);

CREATE INDEX impact_cache_week_last_week_points_idx
  ON impact_leaderboard_cache (start_week, end_week, last_week_points);

CREATE INDEX impact_cache_week_glow_worth_idx
  ON impact_leaderboard_cache (start_week, end_week, glow_worth_wei);
```

The `data` column stores the full `GlowImpactScoreResult` JSON for each wallet.

**Performance Impact**: These indexes improved query performance from ~5-10s to ~500ms (10-20x faster) for leaderboard requests.

## `GET /impact/delegators-leaderboard`

Delegators-only leaderboard (launchpad/vault participants) with **net rewards** accounting.

### What it returns

`wallets[]` rows contain:

- `rank`: 1-based rank (sorted by `netRewardsWei` descending)
- `walletAddress`
- `activelyDelegatedGlwWei`: the wallet's **vault ownership** share of remaining GLW protocol-deposit principal at `endWeek` (wei)
- `glwPerWeekWei`: **most recent week's** gross rewards for the wallet, computed as:
  - `walletInflationFromLaunchpad` + `walletProtocolDepositFromLaunchpad` (GLW-only)
  - Uses the most recent week that actually has finalized rewards data from Control API (may be < `endWeek` if GCA reports haven't been generated yet)
  - Control API rewards are finalized on Thursday for the previous week, so there's typically a lag of a few days after the protocol week ends (Sunday 00:00 UTC)
- `netRewardsWei`: the wallet's "true profit" over the requested week range:
  - `grossRewardsWei - principalAllocatedWei`
  - where `grossRewardsWei` is the sum over weeks `[startWeek..endWeek]` of (launchpad inflation + GLW protocol-deposit received)
  - and `principalAllocatedWei` is computed from the vault model as the wallet’s share of protocol-deposit principal released over the same range (farm distributed deltas × wallet split at each week)
- `sharePercent`: this wallet’s % share of **total gross rewards** across all wallets in the leaderboard period (string like `"13.0"`)

### Query

- `startWeek` (optional): defaults to `getWeekRange().startWeek` (97)
- `endWeek` (optional): defaults to `getWeekRange().endWeek` (last completed week)
- `limit` (optional): default `200`

Example:

```bash
curl -sS "http://localhost:3005/impact/delegators-leaderboard?limit=50"
```
