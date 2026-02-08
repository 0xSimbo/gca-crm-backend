# CRM_POL_DASHBOARD_PLAN.MD

Purpose: define the CRM backend additions required for the PoL dashboard (farm/region revenue, FMI inputs, active farms, vesting schedule). This is the execution plan for a Codex session in `gca-crm-backend`.

## 0) Decisions & Constraints (Final)

- **PoL definition:** `Total_PoL_lq = Endowment_lq + Bot_active_lq` (Ponder is source of truth for PoL balances/yield).
- **Yield scope:** Uniswap LP fees + bot trading (rebalance) profits only. DCA/deposits/capital flows are not yield.
- **Windowing:** use **13-week (~90d)** smoothing for PoL yield metrics and graphs.
- **Miner sales:** count toward PoL **immediately at sale time** (no bot/endowment deposit gating).
- **Active farms:** farms with **PD > 0** (canonical PD field = `applications.paymentAmount`).
- **FMI:** sell pressure is **DEX sell flow (swap-based)** from Ponder. No off-chain sales ledger for FMI.
- **FDV:** exclude PoL wallets (bot + endowment). (Used on frontend; CRM provides vesting schedule only.)
- **GLW spot price:** always use **Ponder API** as source of truth. When computing historical values (e.g., miner sales), use **price at tx block/time** from Ponder. **Do not** use `getCachedGlwSpotPriceNumber`.
- **Ponder API base in CRM:** use `CLAIMS_API_BASE_URL`.
- **Week boundaries:** always use **protocol weeks**. Week number = `floor((timestamp_sec - 1700352000) / 604800)`. Week window = `[start, end)` where `start = genesis + week*604800`.

## 1) Dependencies

- **Ponder endpoints** (must exist via `CLAIMS_API_BASE_URL`):
  - `GET /pol/yield?range=90d` → PoL yield + APY inputs (use `yieldPerWeekLq`, `strategyReturns90dLq`, `uniFees90dLq`)
  - `GET /pol/summary` → optional sanity check for current PoL balances (endowment + bot active)
  - `GET /pol/reserves` → optional (supply model uses this on FE)
  - `GET /fmi/sell-pressure?range=...` → **Sell pressure** source (DEX swap-based weekly series)
  - `GET /spot-price?timestamp=...` or `GET /spot-price?block=...` → **GLW price at time of sale** (for miner sales lq conversion)

CRM should periodically ingest PoL yield and store weekly / 13w aggregates for dashboard use.

## 2) Data Sources Required in CRM

1. **Miner sales ledger (already in CRM)**
   - Source: **Fractions router** via `fraction_splits`
   - Rule: `fractions.type = "mining-center"` and `amount` (USDC) treated as USD
   - Mapping details:
     - `fraction_splits` → join `fractions` on `fraction_id`
     - `fractions.applicationId` → join `applications` on `application_id`
     - `applications.farmId` → join `farms` on `farm_id`
     - Region from `farms.region`
     - Timestamp from `fraction_splits.timestamp` (unix seconds)
   - Amount from `fraction_splits.amount` (USDC 6 decimals → USD)
   - Ignore refunds (miner sales are never refunded)
   - Sales revenue in USD
   - Region attribution
   - Timestamp
   - Counted immediately at sale time
2. **Bounty payments** (deducted from miner sales before PoL attribution)
   - For now, maintain in CRM as a manually-updated table keyed by `applicationId`.
   - Expect temporary lag/zero values immediately after sales; accept short-term inaccuracies.
   - Seed with the initial mapping in section **10** below (`CASH_BOUNTY_BY_APPLICATION_ID`).
3. **GCTL mints**
   - Source: **Weekly report JSON** `weekly-report-week-${week}.json` → `controlMintedEvents`
   - Mint USD value
   - Timestamp
   - Zone attribution by **staked GCTL**
4. **GCTL staking by region**
   - Source: **Weekly report JSON** `weekly-report-week-${week}.json` → `zoneStakeMap`
   - Use `zoneStakeMap.totalStaked`
   - Staked GCTL per `zoneId` (for allocation)
5. **Impact Credits (ICs/CCs)**
   - Canonical weekly IC source: `applications_audit_fields_crs.netCarbonCreditEarningWeekly`
   - Treat as **average weekly rate** per farm (constant across weeks)
6. **Farm registry**
   - farm id, name, region, panels, status, PD > 0 flag, image url

## 3) Revenue Attribution Pipeline (Farm + Region)

### 3.1 Bucketing Rules (Widget 3 spec)
- **10-week bucketing** for:
  - Miner sales revenue
  - GCTL mint PoL contributions
  - GCTL yield PoL contributions (if included in farm attribution)

### 3.2 Miner Sales Attribution
1. Compute net miner sales after bounty:
   - `net_miner_sales_usd = miner_sales_usd - bounty_paid_usd`
2. Convert USD to lq using **GLW price at time of sale**:
   - `miner_lq = net_miner_sales_usd / (2 * sqrt(glw_price_at_sale))`
2. Bucket evenly into 10 weeks: `weekly_bucket = miner_lq / 10`
3. Allocate 100% to the sale’s `zone_id`
4. Within zone, distribute by **Impact Credits per farm for that week**

### 3.3 GCTL Mint Attribution
1. Convert mint USD to lq (same formula)
2. Bucket evenly into 10 weeks
3. Allocate to region by **staked GCTL share** for that week
4. Within zone, distribute by **Impact Credits per farm**

### 3.4 GCTL Yield Attribution (required)
- Yield sources: PoL yield from Ponder
- Bucket over 10 weeks
- Zone allocation by **staked GCTL**
- Farm allocation by **Impact Credits**

### 3.5 Aggregates
- **Per farm**: lifetime lq, 90d lq (13 weeks), cc/week
- **Per zone**: lifetime lq, 90d lq, cc/week, farm count, staked GCTL
- **Aggregate KPIs**: lifetime revenue, 90d revenue, 90d PoL yield, active farms

## 4) FMI Inputs (No Fallback)

CRM must provide **weekly** (or range) values:

```
Buy_Pressure = Miner_Sales_Weekly + GCTL_Mints_Weekly + PoL_Yield_Weekly_USD
Sell_Pressure = DEX_Sell_Pressure_Weekly (swap-based)
```

- PoL_Yield_Weekly_USD = `2 * PoL_Yield_Weekly_lq * sqrt(GLW_price)` from Ponder yield.
- Sell pressure is pulled from **Ponder** swap flow (`/fmi/sell-pressure`), not a treasury sales ledger.
- **Use `sell.glw` as the sold amount**. Convert to USD using **spot price at week end** (from `/spot-price?timestamp=weekEnd`).
- **Naming:** use `dex_sell_pressure_weekly_usd` in CRM responses (avoid `token_sales_weekly_usd` naming ambiguity).

## 5) Vesting Schedule

CRM should expose vesting unlock schedule for the Unlock/FDV widget.
- Use a stored schedule table populated by **CSV**.
- For now: add a **fake CSV** (TODO) and mark as placeholder.
- Suggested path: `data/vesting_schedule.csv`
- Suggested columns: `date,unlocked` (ISO date, numeric unlocked amount)
- Format as yearly series or weekly points as needed by frontend.

## 6) New/Updated CRM Endpoints

### 6.1 Revenue + Farms
- `GET /pol/revenue/aggregate?range=90d`
  - `lifetime_lq`, `ninety_day_lq`, `ninety_day_yield_lq`, `ninety_day_apy`, `active_farms`
  - Lifetime alignment fields (internal/debug):
    - `lifetime_attributed_lq`: sum of weekly attributed revenue (DB snapshot sum, pre-adjustment)
    - `lifetime_cgp_adjustment_lq`: delta applied so displayed lifetime matches current Total PoL
  - Note: `lifetime_lq` is a **display value** that is aligned to current Total PoL (from Ponder `/pol/summary`) by allocating the delta into CGP (zone `1`) in the farm/region endpoints.
- `GET /pol/revenue/farms?range=90d`
  - array of farms:
    - `farm_id`, `name`, `zone_id`, `panels`, `lifetime_lq`, `ninety_day_lq`, `ninety_day_delta_pct`, `credits_total`, `cc_per_week`, `image_url`
    - `audit_week`: protocol week derived from `farms.auditCompleteDate` (proxy for "builtEpoch" until we ingest Control's builtEpoch)
    - `lifetime_attributed_lq`: pre-adjustment lifetime (from weekly attributed snapshots)
    - `lifetime_cgp_adjustment_lq`: farm-level delta applied (only non-zero for CGP farms, zone `1`, unless CGP is empty)
- `GET /pol/revenue/regions?range=90d`
  - array of zones:
    - `zone_id`, `lifetime_lq`, `ninety_day_lq`, `cc_per_week`, `farm_count`, `staked_gctl`
    - `lifetime_attributed_lq`: pre-adjustment lifetime (from weekly attributed snapshots)
    - `lifetime_cgp_adjustment_lq`: region-level delta applied (entire delta is assigned to CGP zone `1`)
- `GET /farms/active-count`
  - `{ count: number }` where PD > 0

### 6.2 FMI
- `GET /fmi/pressure?range=7d`
  - `miner_sales_weekly_usd`, `gctl_mints_weekly_usd`, `pol_yield_weekly_usd`, `dex_sell_pressure_weekly_usd`
  - derived `buy_pressure`, `sell_pressure`, `net`, `buy_sell_ratio`

### 6.3 Vesting
- `GET /glw/vesting-schedule`
  - array of `{ year, unlocked }` or `{ date, unlocked }`

## 7) Storage / Jobs

- **Weekly snapshot tables** to avoid recomputation on every request:
  - `pol_revenue_by_farm_week`
  - `pol_revenue_by_region_week`
  - `pol_yield_week` (ingested from Ponder)
  - `fmi_weekly_inputs`
- **Cron job** to backfill and update weekly buckets (protocol week boundary).

## 8) Tests Required

- Unit tests for:
  - 10-week bucketing and allocation math
  - farm/region aggregation (lifetime + 90d)
  - FMI pressure derivation
- Integration tests for endpoints (happy path + empty data)

## 9) Open Inputs

- Confirm **DEX swap source rules** for Ponder (GLW in / USDG out).
- Confirm **GLW price source** for lq conversions and **historical price at sale time** (Ponder spot price history or another oracle). Use Ponder as the canonical source.

## 10) Initial Cash Bounty Seed (to move into Hub storage)

```ts
const CASH_BOUNTY_BY_APPLICATION_ID: Record<string, number | null> = {
  "83b11acc-5207-47b5-a07f-483db5e48871": 1000,
  "9c712552-e0bf-4a30-babd-9962f311929f": 1500,
  "970c24ed-6273-4899-b8a1-c0c3742d9ae9": 1500,
  "ed8eecb0-1509-4d7c-8337-a958e6064b5c": 1500,
  "54c1ce52-15d3-4dbd-85d0-eb06f6feed8a": 1500,
  "8dcf8df9-9d1b-4c10-b648-ac7b2f63dd28": 1500,
  "a315a8e5-dcd7-4e2b-bdba-54a34e03e826": 4000,
  "61e1d3c1-2682-4025-9db8-7d160bedf315": 2500,
  "c41fc798-7cde-461c-a0f5-f9742a701990": 2000,
  "8dd53eae-4dcf-4877-a5aa-492bb1ff72e9": 1,
  "71c4918e-19dd-4bb7-bcae-b27532eb4c94": 2500,
  "25d454f1-a021-435c-b46a-476fca1b0d45": 1800,
  "6dd28b54-745b-4e51-84fb-a5d9fd1432da": 1600,
  "1987c17d-b927-410a-b1b4-2993beb33dbf": 500,
  "c63b17d1-e3be-4bc4-92b9-f5df3d2b0e92": 2000,
  "737a6761-01ac-46f9-8794-e45d3afd7726": 800,
  "ca7ae649-974e-437d-a843-2a65b08aeb2f": 3000,
  "93eeaf4d-3f43-41e1-8b7f-0f8018ed78d1": 6500,
  "f6963add-86a4-48f0-81a7-5b8b2f0b680f": 1500,
  "7be6c9e7-5ef5-4fd8-b67a-040d6e436822": 2500,
  "b4d5f092-9c99-44ee-a14a-bcf7ed2fc636": 2600,
  "51e2d48b-243c-4909-bc26-2b15b77daed7": 1200,
  "cc098775-8a92-4f28-924e-4c1ba8c7a4f6": null,
};
```

## 11) Ponder Response Shapes (Canonical)

### `/pol/yield?range=90d`
```json
{
  "range": "90d",
  "strategyReturns90dLq": "string",
  "uniFees90dLq": "string",
  "polStartLq": "string",
  "apy": "string",
  "yieldPerWeekLq": "string",
  "indexingComplete": true
}
```
Notes:
- LQ fields are **raw lq** with **12 decimals** (sqrt(USDC 6 * GLW 18) = 1e12).
- `apy` is a decimal string (e.g., `0.1234` = 12.34%).

### `/fmi/sell-pressure?range=12w`
```json
{
  "range": "12w",
  "weekRange": { "startWeek": 0, "endWeek": 0 },
  "series": [
    {
      "week": 0,
      "sell": { "glw": "string", "usdg": "string", "swaps": 0 },
      "buy": { "glw": "string", "usdg": "string", "swaps": 0 },
      "net": { "glw": "string", "usdg": "string" }
    }
  ],
  "indexingComplete": true
}
```
Notes:
- `glw` amounts are **raw GLW** (18 decimals).
- `usdg` amounts are **raw USDG** (6 decimals).
- `week` is protocol week number.

### `/spot-price?timestamp=...` or `/spot-price?block=...`
```json
{
  "spotPrice": "string",
  "blockNumber": "string | null",
  "timestamp": "string | null",
  "indexingComplete": true
}
```
Notes:
- `spotPrice` is **USDG per GLW** formatted to 6 decimals (string).
- `timestamp` is **unix seconds** string.

## 12) Control API Response Shapes (Canonical)

### `GET /events/minted`
```json
{
  "page": 1,
  "limit": 50,
  "events": [
    {
      "wallet": "0x...",
      "txId": "0x...",
      "epoch": 0,
      "amountRaw": "string",
      "currency": "USDC",
      "gctlMinted": "string",
      "ts": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```
Notes:
- `amountRaw` is token decimals (USDC 6).
- `gctlMinted` is atomic (18 decimals).
- `ts` is ISO string.

### `GET /regions/active/summary`
```json
{
  "metadata": {
    "epochs": [0],
    "epochTimestamps": { "0": 1700352000 },
    "currentEpoch": 0
  },
  "total": {
    "totalGctlStaked": "string",
    "totalGlwRewards": "string"
  },
  "regions": [
    {
      "id": 1,
      "name": "Region Name",
      "code": "region_code",
      "slug": "region_slug",
      "isUs": true,
      "currentGctlStaked": "string",
      "glwRewardPerWeek": "string",
      "rewardShare": "string",
      "data": [
        {
          "epoch": 0,
          "timestamp": 1700352000,
          "gctlStaked": "string",
          "pendingUnstake": "string",
          "pendingRestakeOut": "string",
          "pendingRestakeIn": "string",
          "netPending": "string",
          "eventCount": 0
        }
      ]
    }
  ],
  "aggregate": {
    "epochs": [0],
    "timestamps": [1700352000],
    "totalGctlStaked": ["string"],
    "eventTypes": ["stake"],
    "regionIds": [1]
  }
}
```
Notes:
- All GCTL fields are **atomic units (18 decimals)**.
