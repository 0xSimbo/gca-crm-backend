# Fractions Router Tests

This directory contains integration tests for the fractions router endpoints.

## Running the Tests

### Prerequisites

1. Ensure the API server is running (either locally or point to a deployed environment)
2. Set the `API_URL` environment variable if testing against a non-local server

### Optional: enable server-side timing logs

`/fractions/rewards-breakdown` supports an on-demand timing log:

- Add `debugTimings=true` (or `1`) to emit a single summary log: `[fractionsRouter] /rewards-breakdown timings { ... }`
- This is useful when investigating performance regressions (DB vs Control API vs compute).

### Run All Tests

```bash
bun test tests/fractions-router/rewards-breakdown.test.ts
```

### Run Specific Test Suite

```bash
# Test wallet with 1 delegation
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Wallet with 1 delegation"

# Test wallet with other farms
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Wallet with 1 other farm"

# Test wallet with both delegations and mining
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Wallet with both delegations and mining"

# Test wallet with vault ownership
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Wallet with vault ownership"

# Test error handling
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Error handling"

# Test performance
bun test tests/fractions-router/rewards-breakdown.test.ts -t "Performance"
```

### Environment Variables

- `API_URL`: The base URL of the API server (default: `http://localhost:3005`)

Example:

```bash
API_URL=https://api.example.com bun test tests/fractions-router/rewards-breakdown.test.ts
```

## Vault Ownership Model

The `/fractions/rewards-breakdown` endpoint supports **vault ownership** in addition to direct fraction purchases.

### What is Vault Ownership?

When a user purchases launchpad fractions (delegations), they receive a "deposit split" representing their share of the farm's principal. This deposit split can be transferred to another wallet via the vault system. The receiving wallet:

- Receives rewards proportional to their vault ownership percentage
- Is treated as a delegator even though they didn't directly purchase fractions
- Has their `amountInvested` calculated based on their share of the remaining principal

### How It Works

1. **Deposit Split History**: The endpoint fetches the wallet's deposit split ownership history from the Control API
2. **Principal Calculation**: For each farm, it fetches the original GLW principal from the applications table
3. **Cumulative Distributions**: It calculates how much of the principal has been distributed as protocol deposits
4. **Amount Invested**: `amountInvested = (remainingPrincipal * splitPercent) / 1,000,000`

### Response Fields

Vault-owned farms appear in `farmDetails` with:

- `type: "launchpad"` (all vaults are delegation-based)
- `isVaultOwnership: true` (flag to distinguish from direct purchases)
- `amountInvested`: The user's share of the remaining principal (in wei)
- `stepsPurchased: 0` (not applicable for vault ownership)

Vault farms contribute to:

- `totalGlwDelegated` in the totals
- `delegatorFarmsCount` in farm statistics
- `delegatorRewards` in the rewards breakdown

Vault farms are **excluded** from `otherFarmsWithRewards` since they're now properly tracked in `farmDetails`.

## Test Coverage

### `/fractions/rewards-breakdown` Endpoint

#### Test Wallets

1. **0x5e230fed487c86b90f6508104149f087d9b1b0a7**

   - Expected: At least 1 delegation (launchpad fraction)
   - Validates: Farm statistics, GLW delegation amounts, APY calculations, weekly breakdowns

2. **0x2e565baa402c232799690d311f4b43d17212a709**

   - Expected: At least 1 "other farm" (farms where the wallet has reward splits but no direct purchases)
   - Validates: Other farms structure, rewards aggregation, weekly breakdowns

3. **0x5abcfde6bc010138f65e8dc088927473c49867e4**

   - Expected: Multiple delegations (>1 launchpad fractions) AND at least 1 mining-center fraction
   - Validates:
     - Both delegator and miner activity in same wallet
     - Farm statistics show both types
     - Separate APY calculations for delegator and miner
     - Investment totals match for both types
     - Detailed breakdowns for both launchpad and mining-center farms

4. **0x77f41144E787CB8Cd29A37413A71F53f92ee050C** (Vault Ownership Example)
   - Expected: Vault ownership on farm "Jade Delta" (farmId: `88a89b48-05cd-4f76-ba3b-ccefc4c3dc19`)
   - The farm was funded by another wallet, but this user owns the vault
   - Validates:
     - Farm appears in `farmDetails` with `isVaultOwnership: true`
     - `amountInvested` reflects vault share of remaining principal
     - Farm contributes to `totalGlwDelegated`
     - Farm does NOT appear in `otherFarmsWithRewards`

#### Test Scenarios

1. **Basic Functionality**

   - Returns correct response structure
   - Includes all required fields
   - Validates data types

2. **Week Range**

   - Default week range (97 to current)
   - Custom week range support
   - Weeks with rewards count

3. **Farm Statistics**

   - Total farms count
   - Delegator-only farms
   - Miner-only farms
   - Farms with both types

4. **Rewards Breakdown**

   - Total GLW delegated (includes vault ownership)
   - Total USDC spent by miners
   - Delegator rewards (last week & all weeks)
   - Miner rewards (last week & all weeks)
   - APY calculations

5. **Other Farms**

   - Farms with reward splits but no purchases AND no vault ownership
   - Inflation and protocol deposit rewards
   - Weekly breakdown validation
   - Weeks left calculation

6. **Mixed Activity (Delegator + Miner)**

   - Wallets with both delegation and mining activity
   - Separate APY calculations for each type
   - Investment totals validation for both types
   - Farm details for both launchpad and mining-center
   - Correct categorization in farm statistics

7. **Vault Ownership**

   - Farms owned via deposit split transfer (not direct purchase)
   - `isVaultOwnership: true` flag present in response
   - `amountInvested` calculated from vault share
   - Vault farms excluded from `otherFarmsWithRewards`
   - Vault farms contribute to `totalGlwDelegated`

8. **Error Handling**

   - Missing required parameters
   - Invalid wallet address format
   - Non-existent wallet
   - Invalid week range

9. **Performance**
   - Response time validation
   - Ensures optimizations are working

## Test Data Validation

The tests validate:

- Response structure and required fields
- Data type correctness (strings, numbers, bigints)
- Mathematical consistency (e.g., total rewards = inflation + deposit)
- Weekly breakdown accuracy
- Farm type classification
- APY calculations presence
- Vault ownership flag (`isVaultOwnership`) when applicable

## Expected Output

When tests pass, you'll see detailed console output including:

```
✓ Wallet 0x5e230fed487c86b90f6508104149f087d9b1b0a7 has X farms
✓ Farm statistics: Y delegator-only, Z miner-only, W both
✓ Total GLW delegated: 123456789...
✓ Other farms with rewards: N
✓ Wallet 0x5abcfde6bc010138f65e8dc088927473c49867e4 has both delegations and mining activity
✓ Delegator farms: A, Miner farms: B
✓ Delegator APY: X.XXXX%, Miner APY: Y.YYYY%
✓ Total delegator investment matches: 123456789...
✓ Total miner investment matches: 987654321...
✓ Wallet 0x77f41144E787CB8Cd29A37413A71F53f92ee050C has vault ownership
✓ Farm "Jade Delta" has isVaultOwnership: true
✓ Vault amountInvested: 123456789...
✓ Response time: XXXms
```

## Performance Benchmarks

After optimizations, expected performance improvements:

- `/rewards-breakdown` endpoint: significantly fewer upstream calls (no per-wallet farm-rewards-history fetches in the wallet path)
- The wallet path now reuses the Control API **batch** wallet rewards endpoint and derives purchases/totals from a single DB query
- Vault ownership adds one additional Control API call (`deposit-splits-history/batch`) and one DB query for farm principals
- Farm rewards history is fetched only for vault-only farms (not farms with direct purchases)
- Typical local dev runs for a single wallet should be sub-second on a warm database; prod latency will include network + platform load

## Troubleshooting

### Tests Failing

1. **Server not running**: Ensure the API server is running on the expected port
2. **Network errors**: Check your network connection and API_URL configuration
3. **Data changes**: Test wallets may have different data over time; adjust expectations accordingly
4. **Timeout errors**: Increase timeout if testing against a slower environment

### Common Issues

- **404 errors**: The wallet may not have any fractions/rewards in the current environment
- **Performance tests failing**: Server may be under load or network latency may be high
- **Week range errors**: Ensure the week numbers are valid for the current protocol state
- **Vault ownership not showing**: Ensure the Control API is returning deposit split history for the wallet
- **Missing `isVaultOwnership` flag**: The farm may have been directly purchased, not transferred via vault
