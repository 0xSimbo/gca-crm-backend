# Non-Account Quote System

## Overview

The non-account quote system allows users to estimate their protocol deposit and carbon metrics without creating an account. Users upload a utility bill, provide Aurora-based weekly energy consumption data, system specifications, and location to receive an instant quote.

## API Endpoints

### GET `/applications/non-account/regions`

Returns list of available regions for quote submission.

### POST `/applications/non-account/quote`

Submit a quote request with utility bill and farm specifications.

**Required Fields:**

- `regionCode`: Region code from regionMetadata
- `weeklyConsumptionMWh`: Weekly energy consumption in MWh (from Aurora Solar)
- `systemSizeKw`: System nameplate capacity in kW
- `latitude`, `longitude`: Farm location coordinates
- `utilityBill`: Utility bill image or PDF (max 10MB)

**Optional Fields:**

- `isProjectCompleted`: Boolean flag indicating if the solar project is already live/completed (default: false)

**Returns:**

- Protocol deposit estimate in USD (6 decimals)
- Weekly carbon credits and debt
- Net carbon credits per MWh
- Efficiency score
- Electricity price extraction details

### GET `/applications/non-account/quote/:id`

Retrieve a previously computed quote by ID.

## Core Calculations

### 1. Protocol Deposit Estimation

The protocol deposit represents the net present value of the solar farm's electricity generation over its lifetime.

#### Formula: Growing Annuity Present Value

```
PV = CF1 × (1 - ((1+g)/(1+r))^N) / (r - g)
```

Where:

- `CF1` = First year cash flow = `weeklyConsumptionMWh × 1000 × pricePerKwh × 52.18`
  - Note: Uses 52.18 weeks per year (365.25 days ÷ 7) for accuracy
- `r` = Discount rate (from `protocolFeeAssumptions.cashflowDiscount` = 0.055 or 5.5%)
- `g` = Escalator rate (state-specific, default 0.0331 or 3.31%)
- `N` = Commitment period (30 years)

#### Discount Rate

The discount rate of **5.5%** reflects:

- U.S. Federal Funds Rate: 4.25%–4.50%
- Risk premium: ~3% (covers default risk, project execution variability, lender margins)

Source: `src/constants/protocol-fee-assumptions.ts`

#### Escalator Rate

State-specific annual electricity price increase rates are derived from:

- Geographic lookup via `getStateFromCoordinates(latitude, longitude)`
- State-to-escalator mapping in `src/lib/geography/state-with-escalator-fees.ts`
- Default fallback: 3.31% (national average)

Reference: [Solar Reviews - Average Electricity Cost Increase Per Year](https://www.solarreviews.com/)

### 2. Electricity Price Extraction

Electricity prices are extracted from utility bills using GPT-4 Vision/GPT-5 with the following methodology:

**CRITICAL: Bills Must Be Pre-Solar**

The system **rejects bills from active solar installations** by detecting:

- Net metering credits or negative energy charges
- Very low consumption patterns
- Solar generation or export charges
- Renewable energy credits

**Why?** Bills from operating solar farms show distorted consumption and fees that don't reflect the true pre-solar electricity cost.

**Extraction Methodology:**

**Step 1: Time-of-Use (TOU) Rate Averaging**

- If multiple rate tiers exist (On-Peak, Mid-Peak, Off-Peak): calculate simple average
- Example: (On-Peak $0.21 + Mid-Peak $0.14 + Off-Peak $0.08) ÷ 3 = $0.143/kWh

**Step 2: Include Only Solar-Affected Charges**

INCLUDE (usage-based, scale with kWh):

- Energy charges (base rate or TOU average)
- Fuel adjustments (if per kWh)
- Transmission cost adjustments (if per kWh)
- Energy cost adjustments (if per kWh)
- Demand side management fees (if per kWh)
- Purchased capacity cost adjustments (if per kWh)
- Environmental fees (if per kWh)
- City/State taxes (ONLY if % of total bill)

EXCLUDE (fixed/demand, NOT affected by solar):

- Demand charges (peak kW-based)
- Delivery/transmission charges (fixed grid fees)
- Service & facility charges (flat monthly)
- Meter fees, connection fees
- Administrative charges (not per kWh)

**Validation:**

- Confidence threshold: ≥ 0.5 (50%)
- Reasonable range: $0.01 - $1.00 per kWh
- Bills uploaded to R2 public bucket for audit trail

### 3. Carbon Metrics

#### Weekly Carbon Credits

```
weeklyCredits = weeklyConsumptionMWh × carbonOffsetsPerMwh × (1 - uncertaintyMultiplier)
```

Where:

- `carbonOffsetsPerMwh`: Location-specific from WattTime API via `getSunlightHoursAndCertificates()`
- `uncertaintyMultiplier`: 0.35 (35% conservative adjustment)

#### Weekly Carbon Debt

Based on manufacturing and installation carbon footprint:

```
tonsCO2PerKWh = (carbonFootprint / 1,000,000) = 40g / 1M = 0.00004 tCO2/kWh

totalCarbonDebtPerKWh = tonsCO2PerKWh × solarIrradiation × performanceRatio × panelLifetime
                      = 0.00004 × 2400 × 0.8 × 30
                      = 2.304 tCO2

adjustedDebtPerKWh = totalCarbonDebtPerKWh × (1 + uncertaintyMultiplier)
                   = 2.304 × 1.35
                   = 3.1104 tCO2/kWh

totalDebtProduced = adjustedDebtPerKWh × systemSizeKw

adjustedTotalDebt = totalDebtProduced × (1 + disasterRisk)^years
                  = totalDebtProduced × (1.0017)^30

weeklyDebt = adjustedTotalDebt / (52 × years)
```

**Constants:**

- `carbonFootprint`: 40 g CO2 / kWh
- `solarIrradiation`: 2400 h / year
- `performanceRatio`: 0.8 (80%)
- `panelLifetime`: 30 years
- `uncertaintyMultiplier`: 0.35 (35%)
- `disasterRisk`: 0.0017 (0.17% per year)

Source: `src/constants/protocol-fee-assumptions.ts`

#### Net Carbon Credits

```
netWeeklyCc = max(0, weeklyCredits - weeklyDebt)
netCcPerMwh = netWeeklyCc / weeklyConsumptionMWh
```

### 4. Efficiency Score

Calculated using SDK utility:

```typescript
import { calculateFarmEfficiency } from "@glowlabs-org/utils/browser";

efficiencyScore = calculateFarmEfficiency(
  protocolDepositUsd6, // Protocol deposit in 6 decimals
  weeklyImpactAssetsWad // Weekly net CC in 18 decimals (WAD)
);
```

Formula (from SDK):

```
efficiencyScore = (CC / PD) / 100,000
```

Represents carbon credits produced per $100,000 of protocol deposit per week. Higher scores indicate more efficient farms.

## Data Storage

All quotes are persisted to the `non_account_quotes` table:

**Input Fields:**

- Region, location, consumption, system size
- Extracted electricity price with confidence score
- Utility bill URL (R2 public bucket)
- Project completion status (boolean flag)

**Computed Fields:**

- Protocol deposit (USD 6-decimal string)
- Weekly credits, debt, net CC
- Efficiency score (double precision)
- Rates used (discount, escalator)

**Admin Field:**

- `cashAmountUsd`: Nullable field for manual validation/override by admins

**Debug Field:**

- `debugJson`: Complete calculation audit trail with all intermediate values

## Validation & Security

**Input Validation:**

- `weeklyConsumptionMWh > 0`
- `systemSizeKw > 0`
- Valid latitude/longitude ranges
- Region code must exist in SDK metadata

**File Validation:**

- Allowed types: JPEG, PNG, WebP, PDF
- Max size: 10MB
- Uploaded to R2 with sanitized filenames

**Rate Limiting:**

- Recommended: Edge-level rate limiting (not implemented in backend)

## Example Quote Flow

1. **User submits:**

   - Region: Utah (UT)
   - Weekly consumption: 1.5 MWh
   - System size: 6.4 kW
   - Location: 40.7608° N, 111.8910° W
   - Utility bill: electricity_bill.pdf

2. **System extracts:**

   - Electricity price: $0.12/kWh
   - Confidence: 0.92

3. **System computes:**

   - State: Utah → escalator rate: 3.5%
   - Discount rate: 5.5% (from constants)
   - CF1 = 1.5 × 1000 × 0.12 × 52 = $9,360
   - Protocol deposit: ~$208,000
   - Weekly carbon credits: 0.53 tCO2e
   - Weekly carbon debt: 0.048 tCO2e
   - Net weekly CC: 0.482 tCO2e
   - Efficiency score: 50.2

4. **Response includes:**
   - Quote ID for retrieval
   - All computed values
   - Extraction confidence and rationale
   - Debug breakdown

## Future Enhancements (Out of Scope)

- Weekly batch processing for "Tuesday reveal"
- Account-based quote acceptance
- Manual admin quote approval workflow
- Integration with full application flow
