# Fractions Router (Public Endpoints)

This document describes the unauthenticated routes exposed by `fractionsRouter.ts`. Each section covers the request details and the response payload returned by the endpoint.

## Performance & Data Sources

The router uses optimized data fetching strategies:

- **Control API Integration**: Uses batch endpoints (`/wallets/farm-rewards-history/batch`) to fetch rewards for multiple wallets efficiently (100 wallets per request).
- **Database Batching**: Batch queries for wallet purchases across multiple wallets to minimize DB round-trips.
- **Caching**: GLW spot price is cached for 30 seconds to avoid redundant blockchain calls.
- **Accurate Reward Splits**: Uses Control API's pre-calculated splits between launchpad and mining-center positions, accounting for changes over time.

**Typical Performance:**

- Single wallet query: ~0.76s
- Platform-wide average (125 wallets): ~1.82s
- 84-94% faster than previous implementation

## `GET /fractions/summary`

- Returns aggregate volume handled by filled fractions.
- **Response**
  - `totalGlwDelegated` (`string`): Sum of `stepPrice * splitsSold` for filled `launchpad` fractions (raw GLW decimals).
  - `totalMiningCenterVolume` (`string`): Sum of `stepPrice * splitsSold` for filled `mining-center` fractions (raw token decimals).
  - `launchpadContributors` (`number`): Unique buyers across filled `launchpad` fractions.
  - `miningCenterContributors` (`number`): Unique buyers across filled `mining-center` fractions.

## `GET /fractions/available`

- Optionally filter by `type` query param (`launchpad` | `mining-center`). When omitted the response is segmented per type.
- Includes only fractions with status `committed` and `expirationAt` in the future.
- **Response when `type` is provided**
  - `type` (`"launchpad" | "mining-center"`).
  - `summary`
    - `totalCount` (`number`): Available fraction count.
    - `totalStepsRemaining` (`string`): Remaining unsold steps across fractions.
    - `totalValueRemaining` (`string`): Remaining inventory value (`stepPrice * remainingSteps`) in raw token decimals.
  - `fractions[]`
    - `id`, `applicationId`, `createdBy`, `stepPrice`, `totalSteps`, `splitsSold`, `expirationAt`, `status`, `type`, `rewardScore`, `token`.
    - `remainingSteps` (`string`): Non-negative residual steps.
    - `remainingValue` (`string`): Residual value in raw token decimals.
- **Response when `type` omitted**
  - `launchpad`: Object shaped like above `summary + fractions` pair.
  - `miningCenter`: Same structure for mining-center fractions.

## `GET /fractions/default-max-splits`

- `applicationId` query param (`string`) is required.
- Determines the max splits allowed for an application.
- **Response**
  - `maxSplits` (`string`).
  - `isDefault` (`boolean`): Indicates whether value is from default config.
  - `source` (`"application_override" | "default_configuration"`).

## `GET /fractions/splits-by-wallet`

- Query params: `walletAddress` (checksummed string) and `fractionId`.
- Returns all splits purchased by a wallet for a fraction.
- **Response**
  - `walletAddress`, `fractionId`.
  - `splits[]`: Raw rows from `fraction_splits` (includes transaction metadata).
  - `summary`
    - `totalTransactions` (`number`).
    - `totalStepsPurchased` (`number`).
    - `totalAmountSpent` (`string`): Sum in token decimals.

## `GET /fractions/splits-activity`

- Optional query params: `limit` (`1-200`, default `50`), `walletAddress`.
- Returns recent purchase activity sorted descending by time.
- **Response**
  - `activity[]`
    - Split fields: `transactionHash`, `blockNumber`, `buyer`, `creator`, `stepsPurchased`, `amount`, `step`, `timestamp`, `purchaseDate`, `currency` (`USDC`|`GLW`).
    - Fraction fields: `fractionId`, `applicationId`, `farmName`, `fractionStatus`, `isFilled`, `progressPercent`, `rewardScore`, `fractionType`.
    - Calculated `stepPrice` (`string`) and `totalValue` (`string`).
  - `summary`
    - `totalTransactions` (`number`).
    - `totalStepsPurchased` (`number`).
    - `totalAmountSpent` (`string`).
    - `uniqueBuyers` (`number`).
    - `uniqueFractions` (`number`).

## `GET /fractions/splits-activity-by-type`

- Query params: `fractionType` (`launchpad` | `mining-center`), optional `limit` (`1-200`, default `50`).
- Same payload shape as `/splits-activity`, scoped to the requested type, with an extra top-level `fractionType` field mirroring the filter.
  - Each activity item also includes `farmName` alongside `fractionId` and `applicationId`.

## `GET /fractions/refundable-by-wallet`

- Query param: `walletAddress`.
- Returns fractions eligible for refund for the wallet.
- **Response**
  - `walletAddress`.
  - `refundableFractions[]`: Entries include `fraction`, `refundDetails`, and `userPurchaseData` enriched in the query helper.
  - `summary`
    - `totalRefundableFractions` (`number`).
    - `totalRefundableAmount` (`string`).
    - `totalStepsPurchased` (`number`).
    - `byStatus`
      - `expired` (`number`).
      - `cancelled` (`number`).

## `GET /fractions/by-id`

- Query param: `fractionId`.
- Returns the fraction row plus the related application's `farmId`.
- **Response**
  - All columns from `fractions` record.
  - `farmId` (`string` | `null`).

## `GET /fractions/average-apy`

- Calculates weighted average APY across all wallets (or filtered subset) by computing individual wallet APYs and averaging them by investment amount.
- Optional query params:
  - `walletAddress` (`string`): Filter to specific wallet (0x-prefixed, 40 hex chars).
  - `farmId` (`string`): Filter to specific farm.
  - `debug` (`string`): Include debug info (`"true"` or `"1"`).
- **Response**
  ```typescript
  {
    startWeek: number;
    endWeek: number;
    walletAddress?: string; // If filtered by wallet
    farmId?: string; // If filtered by farm
    totals: {
      totalGlwDelegated: string; // Total GLW delegated by all delegators (18 decimals)
      totalUsdcSpentByMiners: string; // Total USDC spent by all miners (6 decimals)
    };
    averageDelegatorApy: string; // Weighted average delegator APY (e.g., "442.4906" = 442.49%)
    averageMinerApyPercent: string; // Weighted average miner APY (e.g., "205.5641" = 205.56%)
    debug?: {
      dataSource: string;
      walletsProcessed: number;
      totalWallets: number;
    };
  }
  ```
- **Formula**
  - Delegator APY: `(earned / invested) × (52.18 / weeks) × 100`
  - Miner APY: `((earned_usdc / invested_usdc) × (52.18 / weeks) - 1) × 100`
- **Notes**
  - Projects rewards over full duration (100 weeks for delegators, 99 for miners).
  - Weighted by investment amount (larger investments have more weight in the average).
  - Uses Control API's batch endpoint for optimal performance (~2s for 125 wallets).
  - Properly splits rewards between launchpad and mining-center for farms with both types.
- **Example**

  ```bash
  # Get overall platform average
  curl -s "http://localhost:3005/fractions/average-apy"

  # Get average for specific wallet
  curl -s "http://localhost:3005/fractions/average-apy?walletAddress=0x5abcfde6bc010138f65e8dc088927473c49867e4"

  # Get average for specific farm
  curl -s "http://localhost:3005/fractions/average-apy?farmId=0947b6e5-21dd-470a-b640-d7d319dd77b6"

  # With debug info
  curl -s "http://localhost:3005/fractions/average-apy?debug=true"
  ```

## `GET /fractions/rewards-breakdown`

- Returns detailed per-farm rewards breakdown and APY calculation for a specific wallet or farm.
- Required query params (one of):
  - `walletAddress` (`string`): Get breakdown for specific wallet (0x-prefixed, 40 hex chars).
  - `farmId` (`string`): Get breakdown for specific farm.
- Optional query params:
  - `startWeek` (`string`): Start week number (defaults to week 97).
  - `endWeek` (`string`): End week number (defaults to last completed week).
- **Response (when walletAddress provided)**
  ```typescript
  {
    type: "wallet";
    walletAddress: string;
    farms: string[]; // Array of farm IDs
    farmStatistics: {
      totalFarms: number;
      delegatorOnlyFarms: number; // Farms with only launchpad
      minerOnlyFarms: number; // Farms with only mining-center
      bothTypesFarms: number; // Farms with both types
    };
    totals: {
      totalGlwDelegated: string; // Total GLW delegated (18 decimals)
      totalUsdcSpentByMiners: string; // Total USDC spent (6 decimals)
    };
    weekRange: {
      startWeek: number;
      endWeek: number;
    };
    rewards: {
      delegator: {
        lastWeek: string; // GLW earned last week (18 decimals)
        allWeeks: string; // Total GLW earned (18 decimals)
      };
      miner: {
        lastWeek: string; // GLW earned last week (18 decimals)
        allWeeks: string; // Total GLW earned (18 decimals)
      };
    };
    apy: {
      delegatorApyPercent: string; // e.g., "457.2677" = 457.27%
      minerApyPercent: string; // e.g., "236.2124" = 236.21%
    };
    farmDetails: Array<{
      farmId: string;
      type: "launchpad" | "mining-center";
      amountInvested: string; // 18 decimals for launchpad, 6 for mining-center
      firstWeekWithRewards: number;
      totalWeeksEarned: number;
      totalEarnedSoFar: string; // GLW earned (18 decimals)
      lastWeekRewards: string; // GLW earned last week (18 decimals)
      apy: string; // Farm-specific APY (e.g., "1036.0200" = 1036.02%)
    }>;
  }
  ```
- **Response (when farmId provided)**
  ```typescript
  {
    type: "farm";
    farmId: string;
    appId: string;
    fractionTypes: ("launchpad" | "mining-center")[];
    wallets: string[]; // Wallet addresses with splits in this farm
    weekRange: {
      startWeek: number;
      endWeek: number;
    };
    rewards: {
      delegator: {
        lastWeek: string;
        allWeeks: string;
      };
      miner: {
        lastWeek: string;
        allWeeks: string;
      };
    };
  }
  ```
- **Notes**
  - For wallets with both launchpad and mining-center in the same farm, shows separate entries with properly split rewards.
  - Uses Control API's wallet-specific split data to accurately allocate rewards.
  - Projects rewards over full duration for APY calculation.
  - Performance: ~0.76s per wallet query.
- **Example**

  ```bash
  # Get breakdown for specific wallet
  curl -s "http://localhost:3005/fractions/rewards-breakdown?walletAddress=0x5abcfde6bc010138f65e8dc088927473c49867e4"

  # Get breakdown for specific farm
  curl -s "http://localhost:3005/fractions/rewards-breakdown?farmId=0947b6e5-21dd-470a-b640-d7d319dd77b6"

  # Custom week range
  curl -s "http://localhost:3005/fractions/rewards-breakdown?walletAddress=0x5abc...&startWeek=98&endWeek=100"
  ```
