# Impact Router

Public endpoints for **Glow Worth** and **Glow Impact Score**.

This is a **status-only leaderboard** (no monetary rewards are paid out by this API). The router exposes data to explain _why_ a wallet ranks where it does, and its “live” potential if it acts now.

## Concepts

### Glow Worth

\[
\\text{GlowWorth} = \\text{LiquidGLW} + \\text{DelegatedActiveGLW} + \\text{UnclaimedGLWRewards}
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
- `UnclaimedGLWRewards`: claimable rewards minus claims (see details below)

### Glow Impact Score

For each week in the requested week range, we compute:

- **Weekly rollover points** (calculated on week rollover):
  - Emissions earned: **+1.0** point per **GLW** earned in emission rewards
  - Steering (sGCTL): **+3.0** points per **GLW** steered by staking GCTL
  - Vault bonus (delegated GLW): **+0.005** points per week per **GLW** in `DelegatedActiveGLW`
- **Weekly multiplier** (calculated on week rollover):
  - Total multiplier = **Base multiplier + Streak bonus**
  - Base multiplier:
    - Standard: **1×**
    - Cash miner bonus: **3×** if the wallet bought a mining-center fraction that week
  - Streak bonus (Impact Streak):
    - Earn **+0.25×** for every consecutive week you **increase your delegated GLW** (net delegation delta > 0 for that week) **or** **buy a miner**
    - Caps at **+1.0×** (after 4 consecutive weeks)
    - Resets to **0×** if you do neither in a week
- **Continuous points** (calculated continuously):
  - GLW Worth: **+0.001** points per week per **GLW** of `GlowWorth` for that week

All points are computed internally with **6-decimal fixed-point precision** and returned as strings.

## Leaderboard timing: “do I move up instantly?”

### What updates instantly (next fetch)

If you **buy/receive GLW now**, the score can change, but it no longer “backfills” the entire history range for liquid balance. The scoring model now uses a **per-week time-weighted average balance (TWAB)** for `LiquidGLW`, derived from indexed ERC20 `Transfer` events, so a brief spike in balance only affects the weeks where you actually held it.

- `GET /impact/glow-worth` still uses on-chain `balanceOf(wallet)` for the **current** `LiquidGLW`.
- The score includes **continuous points** based on `GlowWorth` for each week in the requested range. For those computations, `LiquidGLW` uses **weekly TWAB** (transfer-indexed) rather than the current `balanceOf` snapshot.
  - This inherently includes **swaps**, since swaps move GLW via standard ERC20 `Transfer` events.

### What does _not_ update instantly

The **weekly rollover components** (inflation / steering / vault bonus / cash-miner multiplier) are derived from **weekNumber-indexed** data sources and behave like weekly accounting:

- Inflation + protocol-deposit recovery come from Control API reward history (by `weekNumber`)
- Steering is derived from Control API **epoch-specific** region rewards and **stake-by-epoch** snapshots; if those endpoints are unavailable, the backend falls back to the **current stake snapshot** method (applied uniformly across the queried week range)
- Cash-miner bonus depends on whether a mining-center fraction purchase happened in a given `weekNumber`

So buying GLW does **not** retroactively change those weekly rollover rows.

### Default week cutoff nuance

By default, `startWeek/endWeek` use `getWeekRange()`:

- `startWeek`: fixed start (currently `97`)
- `endWeek`: the **last completed week for reports** (based on a Thursday 00:00 UTC report schedule), not “the in-progress current protocol week”.

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

- **Single wallet** (`walletAddress=0x...`): returns the full object including `glowWorth`, `totals`, `weekly[]`, and `currentWeekProjection` (live preview).
- **Leaderboard/list** (omit `walletAddress`): returns lightweight rows with totals + a `composition` breakdown + `lastWeekPoints` + `activeMultiplier`.
- **Leaderboard/list (no `limit`)**: when `limit` query param is omitted, response also includes `totalWalletCount`.

#### Leaderboard eligibility (who can show up?)

The leaderboard is **not** limited to “protocol participants” anymore. In list mode, the backend builds an eligible wallet universe from:

- **All GLW holders** (ponder listener `glowBalances` where balance > 0)
- **All wallets with staked GCTL** (Control API `wallets.stakedControl > 0`)
- **Protocol wallets** already known to the backend (fraction buyers + reward split wallets)

Internal/team wallets are still excluded via the router’s `EXCLUDED_LEADERBOARD_WALLETS` list.

#### Leaderboard output vs eligibility (why `totalWalletCount` can be > returned rows)

- `totalWalletCount` (when included) refers to the **eligible wallet universe** (after excluding internal/team wallets).
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
}): Promise<ImpactScoreLeaderboardResponse> {
  const url = new URL("/impact/glow-score", params.baseUrl);
  if (params.startWeek != null)
    url.searchParams.set("startWeek", String(params.startWeek));
  if (params.endWeek != null)
    url.searchParams.set("endWeek", String(params.endWeek));
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());

  return (await res.json()) as ImpactScoreLeaderboardResponse;
}
```

### Performance guidance

- `includeWeekly=true|1` on `/impact/glow-score` can be **very large** when you query many wallets; avoid using it for leaderboard screens.
- For dashboards, fetch a single wallet with `walletAddress` and a bounded `startWeek/endWeek`.
- Some Control API calls are cached in-process to reduce repeated work (e.g. region rewards are cached for ~30s).
- The `/impact/glow-score` **list** response is cached in-process for ~10 minutes (single-wallet responses are not cached, since `currentWeekProjection` is meant to feel “live”).
- In list mode, the backend may score a **candidate subset** (e.g. protocol wallets + GCTL stakers + top GLW holders) to keep latency reasonable while still returning the top `limit` by score.

### Profiling / debugging leaderboard latency

`GET /impact/glow-score` supports an on-demand timing log (list mode only):

- Add `debugTimings=true` (or `1`) to emit a single summary log showing which stages are slow.

Local repro script:

```bash
bun run scripts/debug-impact-leaderboard.ts --limit 50 --warmup 1 --repeat 3
```

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
    - **MinerPool** claims are indexed from GLW `Transfer` logs and do not include a week; in **single-wallet (“accurate”)** mode we infer the reward week by matching the claim `amount` to the Control API `glowInflationTotal` for that week (with a tiny wei epsilon to tolerate downstream rounding)
  - **Modes**:
    - **Single wallet** (`walletAddress=...`): uses `"accurate"` attribution (RewardsKernel nonce + MinerPool amount matching) to match on-chain truth without doing direct onchain reads
    - **List/leaderboard mode**: uses `"lite"` behavior to keep scoring cheap; it does not attempt MinerPool week inference, so unclaimed inflation can be an over-estimate (upper bound)

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

Query:

- `walletAddress` (optional): when provided returns full weekly breakdown
- `startWeek`, `endWeek` (optional)
- `limit` (optional): default `200`
- `includeWeekly` (optional): `true|1` to include weekly rows when querying multiple wallets (can be large)
