# PoL Dashboard Backend TODO (Source: `CRM_POL_DASHBOARD_PLAN.MD`)

This checklist tracks implementation work for the PoL dashboard backend additions.

## Decisions/Constraints (No Code, Enforced in Impl)
- [ ] Enforce PoL definition and yield scope (Ponder as source of truth, yield excludes flows)
- [ ] Use protocol week boundaries everywhere (genesis `1700352000`, 1w = `604800s`)
- [ ] Use 13-week (~90d) smoothing for PoL yield metrics
- [ ] Use Ponder spot price (historical at tx time) for USD<->LQ conversions

## Schema + Storage
- [ ] Add `pol_cash_bounties` table keyed by `applicationId` (seed from plan section 10)
- [ ] Add `glw_vesting_schedule` table populated from CSV
- [ ] Add weekly snapshot tables:
  - [ ] `pol_yield_week`
  - [ ] `pol_revenue_by_farm_week`
  - [ ] `pol_revenue_by_region_week`
  - [ ] `fmi_weekly_inputs`
  - [ ] (supporting) `gctl_mint_events` and `gctl_staked_by_region_week`
- [ ] Add migrations for all of the above + indexes/constraints

## Ingestion / Cron
- [ ] Implement Ponder client helpers (base URL = `process.env.CLAIMS_API_BASE_URL`)
- [ ] Ingest PoL yield snapshot weekly (`/pol/yield?range=90d`)
- [ ] Ingest DEX sell-pressure weekly series (`/fmi/sell-pressure?range=12w`)
- [ ] Ingest GCTL mints from Control API (`/events/minted`) into `gctl_mint_events`
- [ ] Ingest GCTL staking by region from Control API (`/regions/active/summary?epochs=...`) into `gctl_staked_by_region_week`
- [ ] Weekly cron to (re)compute:
  - [ ] miner sales contributions (from `fraction_splits` + `fractions.type="mining-center"` minus bounty)
  - [ ] GCTL mint contributions (allocated by staked GCTL share)
  - [ ] farm + region revenue snapshots
  - [ ] FMI weekly inputs (buy/sell pressure + derived metrics)
- [ ] Add manual trigger endpoint(s) for the cron/backfill (for ops)

## API Endpoints
- [ ] `GET /pol/revenue/aggregate?range=90d`
- [ ] `GET /pol/revenue/farms?range=90d`
- [ ] `GET /pol/revenue/regions?range=90d`
- [ ] `GET /farms/active-count`
- [ ] `GET /fmi/pressure?range=7d`
- [ ] `GET /glw/vesting-schedule`

## Data Rules
- [ ] Miner sales use `fraction_splits.timestamp`, USDC6 treated as USD, no refunds
- [ ] Bounty deducted before PoL attribution (allow null bounty values)
- [ ] Impact Credits per farm from `applications_audit_fields_crs.netCarbonCreditEarningWeekly` (treated as constant weekly rate)
- [ ] 10-week bucketing for miner sales and GCTL mint contributions
- [ ] FMI sell pressure uses Ponder DEX swap `sell.glw` converted to USD using spot price at week end
- [ ] Response naming uses `dex_sell_pressure_weekly_usd` (not `token_sales_weekly_usd`)

## Vesting CSV
- [ ] Add placeholder `data/vesting_schedule.csv`
- [ ] Add CSV ingestion script + docs

## Tests
- [ ] Unit tests: 10-week bucketing + allocation math + aggregation windows
- [ ] Unit tests: FMI pressure derivation + USD/LQ conversions (spot-price based)
- [ ] Integration-ish tests: endpoint handlers with mocked data sources (happy path + empty)

