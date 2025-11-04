# Fractions Router (Public Endpoints)

This document describes the unauthenticated routes exposed by `fractionsRouter.ts`. Each section covers the request details and the response payload returned by the endpoint.

## Recent Improvements

### Week Range Calculation Fix

- Changed from `getProtocolWeek() - 1` to `getProtocolWeek() - 2`
- Ensures only fully completed weeks with available reward data are included
- Fixes issue where wallets with rewards in previous weeks showed 0 if current week had no rewards yet

### New Endpoints

- **`/wallets/activity`**: List all wallets with their delegation amounts and rewards earned
- **`/farms/activity`**: List all farms with total rewards distributed and participant counts
- Both endpoints support filtering by type (delegator/miner/both), custom sorting, and limiting results

### Enhanced Data

- `/rewards-breakdown` now includes:
  - `delegatedAfterWeekRange`: Shows delegations made after the week range (not yet earning rewards)
  - `totals`: Only includes amounts within the week range (actually earning rewards)
  - Per-farm breakdown of inflation vs protocol deposit rewards
- All endpoints now use updated Control API paths (`/farms/by-wallet/...` and `/farms/rewards-history/batch`)

## Performance & Data Sources

The router uses optimized data fetching strategies:

- **Control API Integration**: Uses batch endpoints (`/farms/by-wallet/farm-rewards-history/batch`) to fetch rewards for multiple wallets efficiently (500 wallets per request).
- **Database Batching**: Batch queries for wallet purchases across multiple wallets to minimize DB round-trips.
- **Caching**: GLW spot price is cached for 30 seconds to avoid redundant blockchain calls.
- **Accurate Reward Splits**: Uses Control API's pre-calculated splits between launchpad and mining-center positions, accounting for changes over time.

**Typical Performance:**

- Single wallet query: ~0.76s
- Platform-wide queries (60+ wallets): ~2-3s
- Uses single batch call for wallet rewards (500 wallets per batch)
- Week range calculation now uses `getProtocolWeek() - 2` to ensure data completeness

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
      totalGlwDelegated: string; // Total GLW delegated within week range (18 decimals)
      totalUsdcSpentByMiners: string; // Total USDC spent within week range (6 decimals)
    };
    weekRange: {
      startWeek: number;
      endWeek: number;
    };
    delegatedAfterWeekRange: {
      totalGlwDelegatedAfter: string; // GLW delegated after endWeek (18 decimals)
      totalUsdcSpentAfter: string; // USDC spent after endWeek (6 decimals)
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
      totalEarnedSoFar: string; // Total GLW earned (18 decimals)
      totalInflationRewards: string; // GLW from inflation (18 decimals)
      totalProtocolDepositRewards: string; // GLW from protocol deposits (18 decimals)
      lastWeekRewards: string; // GLW earned last week (18 decimals)
      apy: string; // Farm-specific APY (e.g., "1036.0200" = 1036.02%)
    }>;
    otherFarmsWithRewards: {
      count: number; // Number of farms where wallet has reward splits but no fraction purchases
      farms: Array<{
        farmId: string;
        farmName: string | null;
        builtEpoch: number | null; // Epoch when farm was built
        weeksLeft: number | null; // Weeks remaining in farm's reward period
        asset: string | null; // Payment currency farm used for PD (e.g., "GLW", "USDC", "USDG")
        totalInflationRewards: string; // GLW from inflation (18 decimals)
        totalProtocolDepositRewards: string; // GLW from protocol deposits (18 decimals)
        totalRewards: string; // Total GLW earned from farm owner/split rewards (18 decimals)
        lastWeekRewards: string; // GLW earned in the last week (18 decimals)
      }>;
    };
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
    delegatedAfterWeekRange: {
      totalGlwDelegatedAfter: string; // GLW delegated after endWeek (18 decimals)
      totalUsdcSpentAfter: string; // USDC spent after endWeek (6 decimals)
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
  - `totals` only include amounts delegated/spent within the week range (earning rewards).
  - `delegatedAfterWeekRange` shows recent activity after the last completed week (not yet earning rewards).
  - `farmDetails` shows farms where wallet purchased fractions (delegator/miner):
    - Each farm includes a breakdown of rewards by source:
      - `totalInflationRewards`: GLW earned from protocol inflation
      - `totalProtocolDepositRewards`: GLW earned from protocol fee deposits (PD)
      - `totalEarnedSoFar`: Sum of inflation + protocol deposit rewards
  - `otherFarmsWithRewards` shows farms where wallet has reward splits but didn't purchase fractions:
    - Typically farm owner rewards or other reward split arrangements
    - Includes breakdown of inflation vs protocol deposit rewards
    - `asset` shows the payment currency the farm used for protocol deposits (GLW, USDC, USDG, etc.)
    - Shows `lastWeekRewards` (most recent week in the range)
    - `weeksLeft` calculation:
      - V1 farms (built before epoch 97): `floor((97 + (100 - (97 - builtEpoch) / 2.08)) - currentWeek)`
        - V1 weeks lived: `97 - builtEpoch`
        - V2 equivalent weeks lived: `weeksLivedInV1 / 2.08`
        - Remaining V2 weeks: `100 - v2EquivalentWeeksLived`
        - End epoch: `97 + remainingV2Weeks`
      - V2 farms (built epoch 97+): `builtEpoch + 100 - currentWeek`
    - Sorted by total rewards (descending)
    - Only fetched if wallet has reward splits in database
    - Uses case-insensitive wallet address matching for reward splits query
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

## `GET /fractions/wallets/activity`

- Returns a list of all wallets that have delegated GLW or purchased mining-center fractions, showing their amounts and rewards earned.
- Optional query params:
  - `type` (`string`): Filter by wallet type - `"delegator"`, `"miner"`, or `"both"` (default: both).
  - `sortBy` (`string`): Sort field - `"glwDelegated"`, `"usdcSpentOnMiners"`, `"delegatorRewardsEarned"`, `"minerRewardsEarned"`, or `"totalRewardsEarned"` (default: `totalRewardsEarned`).
  - `limit` (`string`): Limit number of results (must be positive number).
- **Response**
  ```typescript
  {
    weekRange: {
      startWeek: number; // Always starts at week 97
      endWeek: number; // Last completed week (getProtocolWeek() - 2)
    }
    summary: {
      totalWallets: number; // Total wallets matching filter
      returnedWallets: number; // Number of wallets returned (after limit)
    }
    wallets: Array<{
      walletAddress: string;
      glwDelegated: string; // GLW delegated within week range (18 decimals)
      usdcSpentOnMiners: string; // USDC spent within week range (6 decimals)
      glwDelegatedAfterRange: string; // GLW delegated after week range (18 decimals)
      usdcSpentAfterRange: string; // USDC spent after week range (6 decimals)
      delegatorRewardsEarned: string; // Total delegator rewards (18 decimals)
      minerRewardsEarned: string; // Total miner rewards (18 decimals)
      totalRewardsEarned: string; // Sum of delegator + miner rewards (18 decimals)
    }>;
  }
  ```
- **Performance**
  - Uses batch database queries and Control API batch endpoints for optimal speed.
  - Typical response time: ~2-3s for all wallets (~60 wallets).
  - 3 total database queries regardless of wallet count:
    1. Batch fetch all farm purchases
    2. Batch fetch purchases up to week range
    3. Batch fetch purchases after week range
- **Notes**
  - Results are sorted by `sortBy` field in descending order.
  - The `*AfterRange` fields show recent delegations/purchases that haven't earned rewards yet (happened after the last completed week).
  - Useful for identifying top delegators/miners and understanding their activity.
  - Filtering by `type=delegator` excludes wallets with only mining-center activity (and vice versa).
- **Example**

  ```bash
  # Get all wallets, sorted by total rewards
  curl -s "http://localhost:3005/fractions/wallets/activity"

  # Get top 10 delegators by amount delegated
  curl -s "http://localhost:3005/fractions/wallets/activity?type=delegator&sortBy=glwDelegated&limit=10"

  # Get top 5 miners by USDC spent
  curl -s "http://localhost:3005/fractions/wallets/activity?type=miner&sortBy=usdcSpentOnMiners&limit=5"

  # Get top 20 earners (delegators and miners combined)
  curl -s "http://localhost:3005/fractions/wallets/activity?sortBy=totalRewardsEarned&limit=20"
  ```

## `GET /fractions/farms/activity`

- Returns a list of all farms that have distributed rewards to delegators or miners, showing reward distributions and participant counts.
- Optional query params:
  - `type` (`string`): Filter by farm type - `"delegator"`, `"miner"`, or `"both"` (default: both).
  - `sortBy` (`string`): Sort field - `"delegatorRewardsDistributed"`, `"minerRewardsDistributed"`, or `"totalRewardsDistributed"` (default: `totalRewardsDistributed`).
  - `limit` (`string`): Limit number of results (must be positive number).
- **Response**
  ```typescript
  {
    weekRange: {
      startWeek: number; // Always starts at week 97
      endWeek: number; // Last completed week (getProtocolWeek() - 2)
    }
    summary: {
      totalFarms: number; // Total farms matching filter
      returnedFarms: number; // Number of farms returned (after limit)
    }
    farms: Array<{
      farmId: string;
      farmName: string | null; // Farm name (or null if not set)
      delegatorRewardsDistributed: string; // Total GLW rewards given to delegators (18 decimals)
      minerRewardsDistributed: string; // Total GLW rewards given to miners (18 decimals)
      totalRewardsDistributed: string; // Sum of delegator + miner rewards (18 decimals)
      uniqueDelegators: number; // Number of unique delegator wallets
      uniqueMiners: number; // Number of unique miner wallets
      totalUniqueParticipants: number; // Total unique participants
    }>;
  }
  ```
- **Performance**
  - Uses same batch queries as `/wallets/activity` for optimal speed.
  - Typical response time: ~2-3s for all farms (~8 farms).
  - Data is aggregated from wallet-specific rewards by farm.
  - Farm names are automatically included from Control API response.
- **Notes**
  - Only includes farms that have distributed rewards (totalRewardsDistributed > 0).
  - Results are sorted by `sortBy` field in descending order.
  - Shows reward distribution breakdown between delegators and miners.
  - Useful for identifying top-performing farms and understanding reward distributions.
  - Filtering by `type=delegator` shows only farms with delegator rewards (and vice versa).
- **Example**

  ```bash
  # Get all farms, sorted by total rewards distributed
  curl -s "http://localhost:3005/fractions/farms/activity"

  # Get top 5 farms by delegator rewards
  curl -s "http://localhost:3005/fractions/farms/activity?type=delegator&sortBy=delegatorRewardsDistributed&limit=5"

  # Get top 3 farms by miner rewards
  curl -s "http://localhost:3005/fractions/farms/activity?type=miner&sortBy=minerRewardsDistributed&limit=3"

  # Get all farms with both delegators and miners
  curl -s "http://localhost:3005/fractions/farms/activity?type=both"
  ```
