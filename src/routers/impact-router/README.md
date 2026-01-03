# Impact Router

Public endpoints for **Glow Worth** and **Glow Impact Score**.

This is a **status-only leaderboard** (no monetary rewards are paid out by this API). The router exposes data to explain _why_ a wallet ranks where it does, and its “live” potential if it acts now.

## Concepts

### Glow Worth

\[
\\text{GlowWorth} = \\text{LiquidGLW} + \\text{DelegatedActiveGLW} + \\text{UnclaimedGLWRewards}
\]

- `LiquidGLW`: on-chain ERC20 GLW `balanceOf(wallet)` (18 decimals / wei)
- `DelegatedActiveGLW`: net delegated GLW currently active in launchpad fractions, modeled as:
  - `sum(launchpad purchases)` **minus** `sum(launchpad refunds)` **minus** `sum(protocolDepositRewardsReceived)` (converted to GLW when needed)
- `UnclaimedGLWRewards`: claimable rewards minus on-chain claims (see details below)

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

If you **buy/receive GLW now**, the **leaderboard score can change immediately** (i.e. as soon as the on-chain transfer is mined and the client refetches), because:

- `LiquidGLW` is fetched from the chain via `balanceOf(wallet)` (current state)
- The score includes **continuous points** based on `GlowWorth` for each week in the requested range, and this implementation uses the **current** `GlowWorth` inputs when computing those weeks.

### What does _not_ update instantly

The **weekly rollover components** (inflation / steering / vault bonus / cash-miner multiplier) are derived from **weekNumber-indexed** data sources and behave like weekly accounting:

- Inflation + protocol-deposit recovery come from Control API reward history (by `weekNumber`)
- Steering is derived from Control API region rewards and the wallet stake snapshot (currently applied uniformly across the queried week range)
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

## `GET /impact/glow-worth`

Computes the wallet's GLW-denominated position:

- `GlowWorth = LiquidGLW + DelegatedActiveGLW + UnclaimedGLWRewards`
- `LiquidGLW`: onchain ERC20 GLW `balanceOf` via `viem`
- `DelegatedActiveGLW`: launchpad GLW delegated minus protocol-deposit rewards received (converted to GLW using current spot price)
- `UnclaimedGLWRewards`: computed as:
  - **Claimable GLW** from Control API weekly rewards (`/wallets/address/:wallet/weekly-rewards?paymentCurrency=GLW`)
  - minus **Claimed GLW** from claims API (`https://glow-ponder-listener-2-production.up.railway.app/rewards/claims/:address`)
  - with a **lag window** (currently 3 weeks) so we don’t treat the most recent weeks as claimable yet

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
