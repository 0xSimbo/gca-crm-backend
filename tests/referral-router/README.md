# Referral Router Tests

This directory contains unit tests for the referral router, covering validation, linking, code generation, and point calculations.

## Running the Tests

### Run All Referral Tests

```bash
bun test tests/referral-router/
```

### Run Specific Test File

```bash
# Validation tests
bun test tests/referral-router/referral-validation.test.ts

# Linking tests
bun test tests/referral-router/referral-linking.test.ts

# Code generation tests
bun test tests/referral-router/referral-code.test.ts

# Feature launch modal tests
bun test tests/referral-router/referral-feature-launch.test.ts

# Referral status projection tests
bun test tests/referral-router/referral-status-projection.test.ts

# Point calculation tests
bun test tests/referral-router/referral-points.test.ts
```

### Run Specific Test Suite

```bash
# Run only validateReferralLink tests
bun test tests/referral-router/referral-validation.test.ts -t "validateReferralLink"

# Run only nonce management tests
bun test tests/referral-router/referral-validation.test.ts -t "Nonce Management"

# Run only grace period tests
bun test tests/referral-router/referral-linking.test.ts -t "Within Grace Period"
```

## Test Files

### `referral-validation.test.ts`

Tests for validation helpers and business rule enforcement.

| Test Suite            | Coverage                                           |
| --------------------- | -------------------------------------------------- |
| `validateReferralLink`| Self-referral, invalid code, code ownership        |
| `isValidReferralCode` | Code format (length, characters, ENS support)      |
| `Nonce Management`    | Initial nonce, increment, case-insensitivity       |
| `canClaimReferrer`    | New users, grace period, expiry                    |
| `canChangeReferrer`   | Alias validation                                   |

### `referral-linking.test.ts`

Tests for the core linking functionality.

| Test Suite                      | Coverage                                        |
| ------------------------------- | ----------------------------------------------- |
| `New Referral`                  | Field creation, grace period, bonus period      |
| `Validation Errors`             | Invalid nonce, self-referral, invalid code      |
| `Within Grace Period`           | Referrer change, previous referrer tracking     |
| `After Grace Period`            | Change rejection                                |
| `Multiple Referees Same Code`   | Multiple referees using same referrer code      |

### `referral-code.test.ts`

Tests for referral code generation and uniqueness.

| Test Suite            | Coverage                                           |
| --------------------- | -------------------------------------------------- |
| `getOrCreateReferralCode` | Creation, idempotency, normalization, format   |
| `Code Uniqueness`     | One code per wallet, globally unique codes         |

### `referral-points.test.ts`

Tests for point calculation logic.

| Test Suite                | Coverage                                       |
| ------------------------- | ---------------------------------------------- |
| `Tiered Referrer Share`   | 5%/10%/15%/20% based on active referral count  |
| `Referee Bonus`           | 10% bonus calculation                          |
| `Activation Bonus`        | 100pt one-time bonus                           |
| `Tier Info`               | Tier names and next tier progression           |
| `Bonus Period`            | 12-week period validation                      |

### `referral-feature-launch.test.ts`

Tests for feature-launch modal tracking when users have or don't have
referral records.

### `referral-status-projection.test.ts`

Tests for `/referral/status` when `includeProjection=1` is provided.

## Test Coverage Summary

| Category           | Tests | Key Invariants                                    |
| ------------------ | ----- | ------------------------------------------------- |
| Validation         | 16    | Self-referral blocked, code format, nonce safety  |
| Linking            | 11    | Grace/bonus periods, referrer changes, multi-use  |
| Code Generation    | 8     | Idempotency, uniqueness, format                   |
| Point Calculation  | 8     | Tiered shares, bonus math, activation, proration  |
| Cron Helpers       | 3     | Activation candidates, tier stabilization         |
| Feature Launch     | 2     | Modal tracking with/without referral records      |
| Status Projection  | 1     | Projected referee bonus points returned           |
| **Total**          | **54**|                                                   |

## Key Invariants Tested

### 1. Self-Referral Prevention

```typescript
it("blocks self-referral", async () => {
  const result = await validateReferralLink({
    referrerWallet: WALLET,
    refereeWallet: WALLET,
    referralCode: "test",
  });
  expect(result.valid).toBe(false);
  expect(result.error).toContain("Self-referral");
});
```

### 2. One Referrer Per Wallet

The `referrals.referee_wallet` column has a UNIQUE constraint. Tests verify:
- First referral creates successfully
- Second referral for same wallet updates (within grace) or fails (after grace)

### 3. Multiple Referees Per Code

The `referrals.referral_code` column is NOT unique. Tests verify:

```typescript
it("allows multiple referees to use same referrer code", async () => {
  await linkReferrer({ refereeWallet: REFEREE_1, code: REFERRER_CODE });
  await linkReferrer({ refereeWallet: REFEREE_2, code: REFERRER_CODE });
  await linkReferrer({ refereeWallet: REFEREE_3, code: REFERRER_CODE });
  // All three should succeed
});
```

### 4. Grace Period Enforcement

```typescript
it("allows change within grace period", async () => {
  // Link with grace period in future
  const result = await canClaimReferrer(refereeWallet);
  expect(result.canChange).toBe(true);
});

it("blocks change after grace period expires", async () => {
  // Link with grace period in past
  const result = await canClaimReferrer(refereeWallet);
  expect(result.canChange).toBe(false);
});
```

### 5. Tiered Referrer Rewards

```typescript
it("calculates tiered referrer share", () => {
  expect(calculateReferrerShare(1000_000000n, 1)).toBe(50_000000n);   // 5% Seed
  expect(calculateReferrerShare(1000_000000n, 3)).toBe(100_000000n);  // 10% Grow
  expect(calculateReferrerShare(1000_000000n, 5)).toBe(150_000000n);  // 15% Scale
  expect(calculateReferrerShare(1000_000000n, 10)).toBe(200_000000n); // 20% Legend
});
```

### 6. Code Idempotency

```typescript
it("returns existing code for wallet (idempotent)", async () => {
  const result1 = await getOrCreateReferralCode(wallet);
  const result2 = await getOrCreateReferralCode(wallet);
  expect(result1.code).toBe(result2.code);
});
```

## Test Data Cleanup

Tests use deterministic test wallet addresses and clean up after each run:

```typescript
const REFERRER_WALLET = "0xaa00000000000000000000000000000000000001";
const REFEREE_WALLET = "0xbb00000000000000000000000000000000000002";

afterEach(async () => {
  await cleanupTestData();
});
```

## Common Issues

### Database Connection

Tests require a running PostgreSQL database. Ensure `DATABASE_URL` is set.

### Cleanup Failures

If tests fail mid-execution, test data may persist. Clean up only fixture rows by exact keys.
Do not run broad pattern deletes. Follow `tests/AGENTS.md` rules:

```text
- Delete by primary/composite key values for rows inserted by the test.
- Avoid deletes based on wide predicates (prefix, ranges, timestamps, etc.).
```

### Timing-Sensitive Tests

Grace period and bonus period tests manipulate dates. If tests fail due to timing:
- Check that test setup correctly sets past/future dates
- Ensure no clock drift between test and database
