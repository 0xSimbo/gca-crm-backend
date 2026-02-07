# PoL Dashboard Backend TODO (Source: `CRM_POL_DASHBOARD_PLAN.MD`)

This checklist tracks implementation work for the PoL dashboard backend additions.

## Decisions/Constraints (No Code, Enforced in Impl)
- [x] Enforce PoL definition and yield scope (Ponder as source of truth, yield excludes flows)
- [x] Use protocol week boundaries everywhere (genesis `1700352000`, 1w = `604800s`)
- [x] Use 13-week (~90d) smoothing for PoL yield metrics
- [x] Use Ponder spot price (historical at tx time) for USD<->LQ conversions

## Schema + Storage
- [x] Add `pol_cash_bounties` table keyed by `applicationId` (seed from plan section 10)
- [x] Add `glw_vesting_schedule` table populated from CSV
- [ ] Add weekly snapshot tables:
  - [x] `pol_yield_week`
  - [x] `pol_revenue_by_farm_week`
  - [x] `pol_revenue_by_region_week`
  - [x] `fmi_weekly_inputs`
  - [x] (supporting) `gctl_mint_events` and `gctl_staked_by_region_week`
- [x] Add migrations for all of the above + indexes/constraints (drizzle schema updated; repo relies on `drizzle-kit push` during deploy)

## Ingestion / Cron
- [x] Implement Ponder client helpers (base URL = `process.env.CLAIMS_API_BASE_URL`)
- [x] Ingest PoL yield snapshot weekly (`/pol/yield?range=90d`)
- [x] Ingest DEX sell-pressure weekly series (`/fmi/sell-pressure?range=12w`)
- [x] Ingest GCTL mints from Control API (`/events/minted`) into `gctl_mint_events`
- [x] Ingest GCTL staking by region from Control API (`/regions/active/summary?epochs=...`) into `gctl_staked_by_region_week`
- [x] Weekly cron to (re)compute:
  - [x] miner sales contributions (from `fraction_splits` + `fractions.type="mining-center"` minus bounty)
  - [x] GCTL mint contributions (allocated by staked GCTL share)
  - [x] farm + region revenue snapshots
  - [x] FMI weekly inputs (buy/sell pressure + derived metrics)
- [x] Add manual trigger endpoint(s) for the cron/backfill (for ops)

## API Endpoints
- [x] `GET /pol/revenue/aggregate?range=90d`
- [x] `GET /pol/revenue/farms?range=90d`
- [x] `GET /pol/revenue/regions?range=90d`
- [x] `GET /farms/active-count`
- [x] `GET /fmi/pressure?range=7d`
- [x] `GET /glw/vesting-schedule`

## Data Rules
- [x] Miner sales use `fraction_splits.timestamp`, USDC6 treated as USD, no refunds
- [x] Bounty deducted before PoL attribution (allow null bounty values)
- [x] Impact Credits per farm from `applications_audit_fields_crs.netCarbonCreditEarningWeekly` (treated as constant weekly rate)
- [x] 10-week bucketing for miner sales and GCTL mint contributions
- [x] FMI sell pressure uses Ponder DEX swap `sell.glw` converted to USD using spot price at week end
- [x] Response naming uses `dex_sell_pressure_weekly_usd` (not `token_sales_weekly_usd`)

## Vesting CSV
- [x] Add placeholder `data/vesting_schedule.csv`
- [x] Add CSV ingestion script + docs

## Tests
- [x] Unit tests: 10-week bucketing + allocation math + aggregation windows (bucketing + allocation covered; aggregation windows exercised via endpoint tests)
- [x] Unit tests: FMI pressure derivation + USD/LQ conversions (spot-price based) (FMI derivation + USD/LQ conversion covered)
- [x] Integration-ish tests: endpoint handlers with mocked data sources (happy path + empty)
