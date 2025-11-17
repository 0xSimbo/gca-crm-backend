# Protocol Deposit Calculation Guide

## Overview

The Protocol Deposit (PD) is calculated using a **growing annuity present value formula** based on the customer's electricity consumption and price. Carbon metrics are computed separately and used for efficiency scoring.

---

## Inputs Required

### User-Provided Inputs
1. **Weekly Consumption (MWh)**: Energy consumption per week
2. **System Size (kW)**: Solar system nameplate capacity
3. **Latitude & Longitude**: Location coordinates
4. **Electricity Price ($/kWh)**: Extracted from utility bill via AI

### Auto-Detected Parameters
- **Region Code**: Derived from coordinates (e.g., Missouri → US-MO)
- **Escalator Rate**: State-specific electricity price inflation rate
- **Carbon Offsets/MWh**: Location-based from NASA/Aurora API
- **Discount Rate**: 5.5% (protocol assumption)
- **Commitment Period**: 30 years (protocol assumption)

---

## Protocol Deposit Calculation

### Formula: Growing Annuity Present Value

The Protocol Deposit represents the present value of future electricity savings over the commitment period.

```
PD = CF₁ × [1 - ((1+g)/(1+r))^N] / (r - g)

Where:
  CF₁ = First-year cash flow from electricity savings
  r   = Discount rate (5.5% or 0.055)
  g   = Escalator rate (state-specific, e.g., 3.31% for Missouri)
  N   = Commitment period in years (30)
```

### Step-by-Step Calculation

**Step 1: Calculate First-Year Cash Flow (CF₁)**
```
CF₁ = Weekly Consumption (MWh) × 1,000 (kWh/MWh) × Price ($/kWh) × 52.18 weeks/year

Example:
  0.3798 MWh/week × 1,000 × $0.10126/kWh × 52.18
  = $2,002.39 / year
```

**Step 2: Apply Growing Annuity Formula**
```
With r=0.055, g=0.0331, N=30:

PD = $2,002.39 × [1 - ((1.0331)/(1.055))^30] / (0.055 - 0.0331)
   = $2,002.39 × [1 - (0.9792)^30] / 0.0219
   = $2,002.39 × [1 - 0.5282] / 0.0219
   = $2,002.39 × 0.4718 / 0.0219
   = $2,002.39 × 21.54
   = $43,131.48
```

**Step 3: Convert to 6 Decimals for Storage**
```
PD_6decimals = round($43,131.48 × 1,000,000) = 43131480000
```

---

## Carbon Metrics Calculation

Carbon metrics are computed separately and used for efficiency scoring, not for PD calculation.

### Weekly Carbon Credits
```
Credits = Weekly Consumption (MWh) × Carbon Offsets (tCO2e/MWh) × (1 - Uncertainty)

Where:
  Uncertainty = 0.10 (10% uncertainty multiplier)

Example:
  0.3798 MWh × 0.5543 tCO2e/MWh × (1 - 0.10)
  = 0.2106 × 0.90
  = 0.1895 tCO2e/week
```

### Weekly Carbon Debt
```
Debt = (Carbon Footprint × Solar Irradiation × Performance × Lifetime × Uncertainty × System Size)
       / (52 weeks × Years)

Where:
  Carbon Footprint = 40 g CO2/kWh → 0.00004 tCO2/kWh
  Solar Irradiation = 2,400 hours/year
  Performance Ratio = 0.8
  Panel Lifetime = 30 years
  Uncertainty Multiplier = 1.35
  Disaster Risk = 0.17%/year

Step 1: Debt per kWh (adjusted)
  = 0.00004 × 2,400 × 0.8 × 30 × 1.35
  = 0.0031104 tCO2/kWh

Step 2: Total debt for system
  = 0.0031104 × 18.96 kW
  = 0.0590 tCO2

Step 3: Adjust for disaster risk over 30 years
  = 0.0590 × (1.0017)^30
  = 0.0593 tCO2

Step 4: Weekly debt
  = 0.0593 / (52 × 30)
  = 0.0000380 tCO2/week
```

### Net Weekly Carbon Credits
```
Net CC = Credits - Debt
       = 0.1895 - 0.0000380
       = 0.1895 tCO2e/week

Net CC per MWh = Net CC / Weekly Consumption
                = 0.1895 / 0.3798
                = 0.4990 tCO2e/MWh
```

---

## Efficiency Score Calculation

The efficiency score measures how much carbon impact is generated per dollar of protocol deposit.

```
Efficiency = (Weekly Impact Assets / Protocol Deposit) × 10,000

Where:
  Weekly Impact Assets = Net Weekly CC × 10^18 (18 decimals)
  Protocol Deposit = PD × 10^6 (6 decimals)

Example:
  Weekly Impact = 0.1895 × 10^18 = 189,500,000,000,000,000
  PD = $43,131.48 × 10^6 = 43,131,480,000
  
  Efficiency = (189,500,000,000,000,000 / 43,131,480,000) × 10,000
             = 4,393.24 × 10,000
             = 43.93 (higher is better)
```

---

## Example API Response

```json
{
  "protocolDeposit": {
    "usd": 43131.48,
    "usd6Decimals": "43131480000"
  },
  "carbonMetrics": {
    "weeklyCredits": 0.1895,
    "weeklyDebt": 0.0000,
    "netWeeklyCc": 0.1895,
    "netCcPerMwh": 0.4990,
    "carbonOffsetsPerMwh": 0.5543,
    "uncertaintyApplied": 0.1
  },
  "efficiency": {
    "score": 43.93,
    "weeklyImpactAssetsWad": "189500000000000000"
  },
  "rates": {
    "discountRate": 0.055,
    "escalatorRate": 0.0331,
    "commitmentYears": 30
  }
}
```

---

## Key Takeaways

1. **Protocol Deposit** is based on **electricity savings**, not carbon credits
2. **Carbon Metrics** measure environmental impact independently
3. **Efficiency Score** combines both: carbon impact per dollar of deposit
4. **Location matters**: Different states have different escalator rates and carbon offsets
5. **System size affects** carbon debt, but not the protocol deposit directly

---

## Formula Summary

| Metric | Formula | Purpose |
|--------|---------|---------|
| Protocol Deposit | PV of growing annuity (electricity savings) | Financial commitment |
| Carbon Credits | Consumption × Offsets × (1 - Uncertainty) | Environmental benefit |
| Carbon Debt | System manufacturing footprint | Environmental cost |
| Net Carbon Credits | Credits - Debt | Net environmental impact |
| Efficiency Score | (Impact / Deposit) × 10,000 | Value proposition |
