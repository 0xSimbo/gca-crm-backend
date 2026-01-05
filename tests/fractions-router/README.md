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

   - Total GLW delegated
   - Total USDC spent by miners
   - Delegator rewards (last week & all weeks)
   - Miner rewards (last week & all weeks)
   - APY calculations

5. **Other Farms**

   - Farms with reward splits but no purchases
   - Inflation and protocol deposit rewards
   - Weekly breakdown validation
   - Weeks left calculation

6. **Mixed Activity (Delegator + Miner)**

   - Wallets with both delegation and mining activity
   - Separate APY calculations for each type
   - Investment totals validation for both types
   - Farm details for both launchpad and mining-center
   - Correct categorization in farm statistics

7. **Error Handling**

   - Missing required parameters
   - Invalid wallet address format
   - Non-existent wallet
   - Invalid week range

8. **Performance**
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
✓ Response time: XXXms
```

## Performance Benchmarks

After optimizations, expected performance improvements:

- `/rewards-breakdown` endpoint: significantly fewer upstream calls (no per-wallet farm-rewards-history fetches in the wallet path)
- The wallet path now reuses the Control API **batch** wallet rewards endpoint and derives purchases/totals from a single DB query
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
