# Impact Router

Public endpoints for **Glow Worth** and **Glow Impact Score**.

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

- **Weekly rollover points**:
  - Inflation earned: **+1.0** point per **GLW** earned in inflation rewards
  - Steering (GCTL): **+3.0** points per **GLW** “steered” via staked GCTL
  - Vault bonus: **+0.005** points per week per **GLW** in `DelegatedActiveGLW`
- **Weekly multiplier**:
  - Cash miner bonus: if the wallet bought a mining-center fraction that week, we apply a **3×** multiplier to all rollover points for that week
- **Continuous points**:
  - **+0.001** points per week per **GLW** of `GlowWorth` for that week

All points are computed internally with **6-decimal fixed-point precision** and returned as strings.

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

- **Single wallet** (`walletAddress=0x...`): returns the full object including `glowWorth`, `totals`, and `weekly[]` rows
- **Leaderboard/list** (omit `walletAddress`): returns `{ weekRange, limit, wallets: { walletAddress, totalPoints, glowWorthWei }[] }`

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
  weekly: ImpactScoreWeeklyRow[];
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
}

interface ImpactScoreLeaderboardResponse {
  weekRange: { startWeek: number; endWeek: number };
  limit: number;
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
  - Uses global region reward distribution from Control API: `GET /rewards/glw/regions`
  - Uses wallet per-region stake totals from Control API: `GET /wallets/address/:wallet`
  - For each region, compute wallet share:
    - `walletShare = walletRegionStake / regionTotalStake`
    - `walletSteeredGlwWei = regionGlwRewardWei * walletShare`
  - Sum across regions to get `steeringGlwWei` per week.
  - Current implementation uses the **current stake snapshot** across the queried week range (no historical stake-by-week yet).
- **Unclaimed rewards**:
  - Derived from Control API weekly rewards minus claim rows fetched from the claims API (`https://glow-ponder-listener-2-production.up.railway.app`).

Query:

- `walletAddress` (optional): when provided returns full weekly breakdown
- `startWeek`, `endWeek` (optional)
- `limit` (optional): default `200`
- `includeWeekly` (optional): `true|1` to include weekly rows when querying multiple wallets (can be large)
