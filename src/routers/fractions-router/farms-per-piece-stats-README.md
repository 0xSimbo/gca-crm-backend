# Farms Per-Piece Stats Endpoint

## Overview

The `/fractions/farms-per-piece-stats` endpoint provides comprehensive per-piece statistics for all farms in the system, showing both delegator (launchpad) and miner (mining-center) data.

## Performance Notes (Implementation Summary)

This endpoint was refactored to avoid timeouts by:

- **Removing Control API fanout**:
  - No `GET /farms/{farmId}/reward-splits` per farm
  - No `GET /farms/by-wallet/{wallet}/farm-rewards-history` per wallet
- **Using a DB-derived buyer set**:
  - Distinct buyers are queried from `fraction_splits` joined to `fractions` + `applications`
  - Participants are computed from buyers (not reward splits / not reward earners)
- **Using Control API batch-only rewards**:
  - `POST /farms/by-wallet/farm-rewards-history/batch` (500 wallets per request)
  - Wallet rewards are aggregated to farm-level weekly totals in a single pass

## Endpoint

```
GET /fractions/farms-per-piece-stats
```

## Purpose

This endpoint aggregates farm-level data to show:

1. **Farms with sales or buyer activity** in the requested range (miners and delegators)
2. **Filled listings count** (how many fraction listings were sold per farm)
3. **Steps sold** (total number of pieces/splits sold across all listings)
4. **Weighted average piece prices** (purchase prices in their respective tokens)
5. **Rewards per piece** distributed to participants (total, inflation, and protocol deposit)
6. **ROI percentages** for both delegators and miners
7. **Weeks earned and weeks left** for each farm type
8. **Weekly breakdown** showing inflation and protocol deposit rewards by week
9. **Participant counts** (unique delegators and miners per farm)

## Query Parameters

| Parameter   | Type   | Required | Default             | Description                               |
| ----------- | ------ | -------- | ------------------- | ----------------------------------------- |
| `farmId`    | string | No       | -                   | Filter results to a specific farm ID      |
| `startWeek` | string | No       | 97                  | Start week number for reward calculations |
| `endWeek`   | string | No       | Last completed week | End week number for reward calculations   |

## Response Format

```typescript
{
  weekRange: {
    startWeek: number;
    endWeek: number;
  }
  farms: Array<{
    farmId: string;
    appId: string;
    farmName: string | null;
    fractionTypes: ("launchpad" | "mining-center")[];
    delegator: {
      filledListings: number; // Number of filled launchpad listings/fractions for this farm
      stepsSold: number; // Total number of steps/splits sold across all listings
      weightedPieceSizeGlw: string; // BigInt as string, 18 decimals
      weeksEarned: number; // Number of weeks the farm has earned delegator rewards
      weeksLeft: number; // Weeks remaining (100 - weeksEarned)
      rewardsPerPiece: {
        total: {
          lastWeek: string; // Total rewards (inflation + PD) per piece, last week
          allWeeks: string; // Total rewards (inflation + PD) per piece, all weeks
        };
        inflation: {
          lastWeek: string; // GLW inflation rewards per piece, last week (18 decimals)
          allWeeks: string; // GLW inflation rewards per piece, all weeks (18 decimals)
        };
        protocolDeposit: {
          lastWeek: string; // PD rewards per piece, last week (asset's native decimals)
          allWeeks: string; // PD rewards per piece, all weeks (asset's native decimals)
        };
      };
      roi: {
        lastWeek: string; // Return on investment % for last week
        allWeeks: string; // Return on investment % for all weeks
      };
      weeklyBreakdown: Array<{
        weekNumber: number;
        inflationRewards: string; // GLW inflation rewards (18 decimals)
        protocolDepositRewards: string; // Protocol deposit rewards (asset's native decimals)
        protocolDepositAsset: string | null; // Payment currency (GLW, USDC, USDG, etc.)
        totalRewards: string; // Sum of inflation + protocol deposit
      }>;
    };
    miner: {
      filledListings: number; // Number of filled mining-center listings/fractions for this farm
      stepsSold: number; // Total number of steps/splits sold across all listings
      weightedPiecePriceUsdc: string; // BigInt as string, 6 decimals
      weeksEarned: number; // Number of weeks the farm has earned miner rewards
      weeksLeft: number; // Weeks remaining (99 - weeksEarned)
      rewardsPerPiece: {
        total: {
          lastWeek: string; // Total rewards (inflation + PD) per piece, last week
          allWeeks: string; // Total rewards (inflation + PD) per piece, all weeks
        };
        inflation: {
          lastWeek: string; // GLW inflation rewards per piece, last week (18 decimals)
          allWeeks: string; // GLW inflation rewards per piece, all weeks (18 decimals)
        };
        protocolDeposit: {
          lastWeek: string; // PD rewards per piece, last week (asset's native decimals)
          allWeeks: string; // PD rewards per piece, all weeks (asset's native decimals)
        };
      };
      roi: {
        lastWeek: string; // Return on investment % for last week
        allWeeks: string; // Return on investment % for all weeks
      };
      weeklyBreakdown: Array<{
        weekNumber: number;
        inflationRewards: string; // GLW inflation rewards (18 decimals)
        protocolDepositRewards: string; // Protocol deposit rewards (asset's native decimals)
        protocolDepositAsset: string | null; // Payment currency (GLW, USDC, USDG, etc.)
        totalRewards: string; // Sum of inflation + protocol deposit
      }>;
    };
    participants: {
      uniqueDelegators: number;
      uniqueMiners: number;
    };
  }>;
}
```

## Example Requests

### Get all farms

```bash
curl "http://localhost:3005/fractions/farms-per-piece-stats"
```

### Get specific farm

```bash
curl "http://localhost:3005/fractions/farms-per-piece-stats?farmId=820f5c83-14a8-413b-a814-2959c2ee176f"
```

### Get stats for custom week range

```bash
curl "http://localhost:3005/fractions/farms-per-piece-stats?startWeek=98&endWeek=100"
```

## Example Response

```json
{
  "weekRange": {
    "startWeek": 97,
    "endWeek": 100
  },
  "farms": [
    {
      "farmId": "820f5c83-14a8-413b-a814-2959c2ee176f",
      "appId": "54c1ce52-15d3-4dbd-85d0-eb06f6feed8a",
      "farmName": "Grand Field",
      "fractionTypes": ["launchpad", "mining-center"],
      "delegator": {
        "filledListings": 1,
        "stepsSold": 79,
        "weightedPieceSizeGlw": "509912854493110142167",
        "weeksEarned": 2,
        "weeksLeft": 98,
        "rewardsPerPiece": {
          "total": {
            "lastWeek": "112509102066433471386",
            "allWeeks": "256564942359609025370"
          },
          "inflation": {
            "lastWeek": "108353999645584095226",
            "allWeeks": "248426290185627185446"
          },
          "protocolDeposit": {
            "lastWeek": "4155102420849376159",
            "allWeeks": "8138652173981839923"
          }
        },
        "roi": {
          "lastWeek": "22.0644",
          "allWeeks": "50.3154"
        },
        "weeklyBreakdown": [
          {
            "weekNumber": 100,
            "inflationRewards": "8559965972001143522876",
            "protocolDepositRewards": "328253091247100716628",
            "protocolDepositAsset": "GLW",
            "totalRewards": "8888219063248244239504"
          },
          {
            "weekNumber": 99,
            "inflationRewards": "11065710952663404127416",
            "protocolDepositRewards": "314700430497464637345",
            "protocolDepositAsset": "GLW",
            "totalRewards": "11380411383160868764761"
          }
        ]
      },
      "miner": {
        "filledListings": 1,
        "stepsSold": 8,
        "weightedPiecePriceUsdc": "599000000",
        "weeksEarned": 2,
        "weeksLeft": 97,
        "rewardsPerPiece": {
          "total": {
            "lastWeek": "1111027382906030529938",
            "allWeeks": "2533578805801139125533"
          },
          "inflation": {
            "lastWeek": "1069995746500142940359",
            "allWeeks": "2453209615583068456286"
          },
          "protocolDeposit": {
            "lastWeek": "41031636405887589578",
            "allWeeks": "80369190218070669246"
          }
        },
        "roi": {
          "lastWeek": "65.1784",
          "allWeeks": "148.6323"
        },
        "weeklyBreakdown": [
          {
            "weekNumber": 100,
            "inflationRewards": "8559965972001143522876",
            "protocolDepositRewards": "328253091247100716628",
            "protocolDepositAsset": "GLW",
            "totalRewards": "8888219063248244239504"
          },
          {
            "weekNumber": 99,
            "inflationRewards": "11065710952663404127416",
            "protocolDepositRewards": "314700430497464637345",
            "protocolDepositAsset": "GLW",
            "totalRewards": "11380411383160868764761"
          }
        ]
      },
      "participants": {
        "uniqueDelegators": 9,
        "uniqueMiners": 4
      }
    }
  ]
}
```

## Data Interpretation

### Delegator (Launchpad) Data

- **filledListings**: Number of filled launchpad listings for this farm

  - Count of separate FILLED launchpad fraction listings that were filled before or during the `endWeek`
  - Shows how many times the farm created and filled a delegator fraction sale

- **stepsSold**: Total number of steps/splits sold across all launchpad listings

  - Sum of all `splitsSold` from all filled launchpad fractions for this farm
  - This is the actual number of pieces purchased by delegators

- **weightedPieceSizeGlw**: Average GLW amount per fraction piece across all filled launchpad listings

  - Calculated as: `sum(stepPrice * stepsSold) / sum(stepsSold)`
  - Unit: GLW with 18 decimals (e.g., "1000000000000000000" = 1 GLW)

- **weeksEarned**: Number of weeks the farm has actually earned delegator rewards

  - Counted from farm-level weekly reward data (weeks where the farm had any inflation or protocol deposit rewards)
  - Used to calculate `weeksLeft`

- **weeksLeft**: Remaining weeks in the 100-week delegator reward period

  - Formula: `100 - weeksEarned`
  - Delegators earn rewards for 100 weeks total from when the farm starts earning

- **rewardsPerPiece**: Rewards earned per piece owned, broken down by type

  - **total**: Combined inflation + protocol deposit rewards per piece
    - `lastWeek`: Total rewards per piece in the most recent completed week
    - `allWeeks`: Total rewards per piece from startWeek to endWeek
  - **inflation**: GLW inflation rewards per piece (18 decimals)
    - Calculated as: `totalInflationRewards / stepsSold`
    - `lastWeek`: Inflation rewards per piece in the most recent completed week
    - `allWeeks`: Inflation rewards per piece from startWeek to endWeek
  - **protocolDeposit**: Protocol deposit rewards per piece (in the payment currency's decimals)
    - Calculated as: `totalProtocolDepositRewards / stepsSold`
    - Decimals depend on payment currency (6 for USDC/USDG/SGCTL/GCTL, 18 for GLW)
    - `lastWeek`: PD rewards per piece in the most recent completed week
    - `allWeeks`: PD rewards per piece from startWeek to endWeek

- **roi**: Return on Investment percentage for delegators

  - Calculated as: `(totalRewardsGlw / totalInvestmentGlw) * 100`
  - Where `totalInvestmentGlw = weightedPieceSizeGlw * stepsSold`
  - Returns percentage as string with 4 decimal places (e.g., "22.0644" = 22.06%)
  - `lastWeek`: ROI for the most recent completed week only
  - `allWeeks`: Cumulative ROI from startWeek to endWeek
  - Note: Delegator ROI is in GLW terms (GLW rewards / GLW invested)

- **weeklyBreakdown**: Array of weekly reward details showing breakdown by reward type
  - `weekNumber`: The epoch/week number
  - `inflationRewards`: GLW inflation rewards allocated to the farm (18 decimals)
  - `protocolDepositRewards`: Protocol deposit rewards distributed (in the payment currency's native decimals)
  - `protocolDepositAsset`: The payment currency used (e.g., "GLW", "USDC", "USDG")
  - `totalRewards`: Sum of inflation + protocol deposit rewards

### Miner (Mining-Center) Data

- **filledListings**: Number of filled mining-center listings for this farm

  - Count of separate FILLED mining-center fraction listings that were filled before or during the `endWeek`
  - Shows how many times the farm created and filled a miner fraction sale

- **stepsSold**: Total number of steps/splits sold across all mining-center listings

  - Sum of all `splitsSold` from all filled mining-center fractions for this farm
  - This is the actual number of pieces purchased by miners

- **weightedPiecePriceUsdc**: Average USDC price per fraction piece across all filled mining-center listings

  - Calculated as: `sum(stepPrice * stepsSold) / sum(stepsSold)`
  - Unit: USDC with 6 decimals (e.g., "1000000" = $1.00 USDC)

- **weeksEarned**: Number of weeks the farm has actually earned miner rewards

  - Counted from farm-level weekly reward data (weeks where the farm had any inflation or protocol deposit rewards)
  - Used to calculate `weeksLeft`

- **weeksLeft**: Remaining weeks in the 99-week miner reward period

  - Formula: `99 - weeksEarned`
  - Miners earn rewards for 99 weeks total from when the farm starts earning
  - Note: Miners have 1 week less than delegators (99 vs 100 weeks)

- **rewardsPerPiece**: Rewards earned per piece owned, broken down by type (in GLW despite USDC investment)

  - **total**: Combined inflation + protocol deposit rewards per piece
    - `lastWeek`: Total rewards per piece in the most recent completed week
    - `allWeeks`: Total rewards per piece from startWeek to endWeek
  - **inflation**: GLW inflation rewards per piece (18 decimals)
    - Calculated as: `totalInflationRewards / stepsSold`
    - `lastWeek`: Inflation rewards per piece in the most recent completed week
    - `allWeeks`: Inflation rewards per piece from startWeek to endWeek
  - **protocolDeposit**: Protocol deposit rewards per piece (in the payment currency's decimals)
    - Calculated as: `totalProtocolDepositRewards / stepsSold`
    - Decimals depend on payment currency (6 for USDC/USDG/SGCTL/GCTL, 18 for GLW)
    - `lastWeek`: PD rewards per piece in the most recent completed week
    - `allWeeks`: PD rewards per piece from startWeek to endWeek

- **roi**: Return on Investment percentage for miners (in USD terms)

  - Calculated as: `((totalRewardsGlw * glwPriceUsd) / totalInvestmentUsdc) * 100`
  - Where:
    - `totalRewardsGlw = (inflationRewards + protocolDepositRewards) / 1e18`
    - `totalInvestmentUsdc = (weightedPiecePriceUsdc * stepsSold) / 1e6`
    - GLW rewards converted to USD using current spot price
  - Returns percentage as string with 4 decimal places (e.g., "65.1784" = 65.18%)
  - `lastWeek`: ROI for the most recent completed week only
  - `allWeeks`: Cumulative ROI from startWeek to endWeek
  - Note: Miner ROI is in USD terms (USD value of GLW rewards / USDC invested)

- **weeklyBreakdown**: Array of weekly reward details showing breakdown by reward type
  - `weekNumber`: The epoch/week number
  - `inflationRewards`: GLW inflation rewards allocated to the farm (18 decimals)
  - `protocolDepositRewards`: Protocol deposit rewards distributed (in the payment currency's native decimals)
  - `protocolDepositAsset`: The payment currency used (e.g., "GLW", "USDC", "USDG")
  - `totalRewards`: Sum of inflation + protocol deposit rewards

### Participants

- **uniqueDelegators**: Number of unique buyer wallet addresses that purchased **launchpad** fraction splits for this farm (up to `endWeek`)
- **uniqueMiners**: Number of unique buyer wallet addresses that purchased **mining-center** fraction splits for this farm (up to `endWeek`)

## Special Cases

### Farms with Only Delegators

```json
{
  "fractionTypes": ["launchpad"],
  "delegator": {
    "stepsSold": 23,
    "weightedPieceSizeGlw": "3574443432084169183859",
    "rewardsPerPiece": { ... }
  },
  "miner": {
    "stepsSold": 0,
    "weightedPiecePriceUsdc": "0",
    "rewardsPerPiece": {
      "lastWeek": "0",
      "allWeeks": "0"
    }
  }
}
```

### Farms with Only Miners

```json
{
  "fractionTypes": ["mining-center"],
  "delegator": {
    "stepsSold": 0,
    "weightedPieceSizeGlw": "0",
    "rewardsPerPiece": {
      "lastWeek": "0",
      "allWeeks": "0"
    }
  },
  "miner": {
    "stepsSold": 20,
    "weightedPiecePriceUsdc": "800000000",
    "rewardsPerPiece": { ... }
  }
}
```

### Farms with No Fraction Sales

```json
{
  "fractionTypes": [],
  "delegator": {
    "stepsSold": 0,
    "weightedPieceSizeGlw": "0",
    "rewardsPerPiece": { "lastWeek": "0", "allWeeks": "0" }
  },
  "miner": {
    "stepsSold": 0,
    "weightedPiecePriceUsdc": "0",
    "rewardsPerPiece": { "lastWeek": "0", "allWeeks": "0" }
  },
  "participants": {
    "uniqueDelegators": 0,
    "uniqueMiners": 0
  }
}
```

## Implementation Details

### Data Sources

1. **Fraction Sales Data** (`getFilledStepStatsByFarm`)

   - Queries all FILLED fractions up to `endWeek`
   - Groups by farm and fraction type
   - Calculates weighted average step prices

2. **Buyer Wallets + Participants** (`getWalletPurchaseTypesByFarmUpToWeek`)

   - Queries distinct buyers from `fraction_splits` joined to fractions/applications
   - Builds wallet → farm → purchased types mapping
   - Computes `uniqueDelegators` / `uniqueMiners` from buyers (not reward-splits)

3. **Weekly Rewards** (Control API `/farms/by-wallet/farm-rewards-history/batch`)

   - Batch fetches wallet reward histories for **buyer wallets** (500 wallets per request)
   - Aggregates per-farm weekly totals in one pass (delegator vs miner buckets)
   - Includes payment currency information (`asset`) for protocol deposit interpretation

4. **Farm Names** (`getFarmNamesByApplicationIds`)
   - Batch fetches farm names from application IDs

### Performance Considerations

- Uses batch API calls to Control API for reward data
- Single optimized DB query for fraction sales aggregation
- Efficient map-based data merging and single-pass aggregation
- Typical response time: ~1-2 seconds locally (can vary with DB size and number of buyer wallets)

### Error Handling

- Returns 500 if `CONTROL_API_URL` is not configured
- Returns 400 for invalid week range parameters
- Handles division by zero safely (returns "0")
- Returns empty arrays for farms with no data

## Use Cases

### Frontend Dashboard

Display farm performance metrics:

- Average piece price (what users paid)
- Current rewards per piece owned
- Participant engagement (delegator vs miner counts)

### Investment Analysis

Compare farms by:

- Weighted piece prices (entry cost)
- Rewards per piece (ROI indicator)
- Participant distribution

### Historical Analysis

Track farm performance over time:

- Use `startWeek`/`endWeek` to analyze specific periods
- Compare `lastWeek` vs `allWeeks` to see reward trends

## Related Endpoints

- `/fractions/summary` - High-level totals across all fractions
- `/fractions/average-apy` - APY calculations (includes projections)
- `/fractions/rewards-breakdown` - Per-wallet or per-farm detailed breakdown
- `/fractions/farms/activity` - Farm-level reward distribution stats

## Notes

- All BigInt values are returned as strings to prevent precision loss in JSON
- Week 97 is the first week of delegation rewards (hardcoded start)
- The endpoint returns farms that have either sales stats or buyer participation within the requested week range
- Inflation rewards are always in GLW (18 decimals)
- Protocol deposit rewards are in the payment currency's native decimals:
  - USDC, USDG, SGCTL, GCTL: 6 decimals
  - GLW: 18 decimals
- Weekly breakdown is aggregated from buyer wallet reward histories (wallet-level data summed to farm totals)
- Weeks earned/left are calculated from actual reward history, not farm build date
- No APY calculations are included (use `/average-apy` for that)
