# Fractions Router (Public Endpoints)

This document describes the unauthenticated routes exposed by `fractionsRouter.ts`. Each section covers the request details and the response payload returned by the endpoint.

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
    - Fraction fields: `fractionId`, `applicationId`, `fractionStatus`, `isFilled`, `progressPercent`, `rewardScore`, `fractionType`.
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
- Returns the fraction row plus the related application’s `farmId`.
- **Response**
  - All columns from `fractions` record.
  - `farmId` (`string` | `null`).
