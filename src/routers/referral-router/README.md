# Referral Router

The referral router handles all referral system functionality including code generation, linking/unlinking referrers, network management, and validation.

## Overview

The referral system enables:

- **Referrer earns 5-20%** of referee's base Impact Points (tiered by network size)
  - Seed (1 ref): 5% | Grow (2-3): 10% | Scale (4-6): 15% | Legend (7+): 20%
- **Referee earns 10% bonus** on their own Impact Points for 12 weeks
- **Referee earns 100pt one-time bonus** when you reach 100 points (activation milestone)
- **7-day grace period** to change referrer, then permanent
- **Points calculated weekly** alongside existing Impact Score rollover

## Directory Structure

```
src/routers/referral-router/
├── referralRouter.ts           # Main router with all endpoints
├── helpers/
│   ├── referral-code.ts        # Code generation logic
│   ├── referral-linking.ts     # Linking/unlinking logic
│   └── referral-validation.ts  # Business validation helpers
└── README.md
```

## Endpoints

### `GET /referral/internal/dashboard`

Internal dashboard stats for team tracking. Returns aggregated referral metrics.

**Response:**

```json
{
  "overview": {
    "totalReferrals": 150,
    "activeReferrals": 85,
    "pendingReferrals": 65,
    "inGracePeriod": 12,
    "inBonusPeriod": 45,
    "activationBonusesAwarded": 85,
    "totalCodesGenerated": 500,
    "uniqueReferrers": 120
  },
  "tierDistribution": {
    "seed": 80,
    "grow": 25,
    "scale": 10,
    "legend": 5
  },
  "topReferrers": [
    {
      "referrerWallet": "0x...",
      "activeReferees": 12,
      "totalReferees": 15,
      "pendingReferees": 3,
      "ensName": "alice.eth",
      "tier": "Legend",
      "tierPercent": 20
    }
  ],
  "recentReferrals": [
    {
      "referrerWallet": "0x...",
      "refereeWallet": "0x...",
      "status": "pending",
      "linkedAt": "2026-01-26T00:00:00Z",
      "gracePeriodEndsAt": "2026-02-02T00:00:00Z",
      "referralCode": "alice.eth",
      "isInGracePeriod": true
    }
  ],
  "weeklyStats": [
    {
      "weekNumber": 114,
      "totalReferrerPoints": "1234.000000",
      "totalRefereeBonusPoints": "567.000000",
      "totalActivationBonusPoints": "500.000000",
      "uniqueReferrers": 25,
      "uniqueReferees": 40
    }
  ],
  "totalPointsAllTime": {
    "referrerPoints": "50000.000000",
    "refereeBonusPoints": "25000.000000",
    "activationBonusPoints": "8500.000000"
  },
  "currentWeek": 114
}
```

### `GET /referral/code`

Get or generate referral code for connected wallet.

**Query params:** `walletAddress` (required)

**Response:**

```json
{
  "code": "alice.eth",
  "shareableLink": "https://glow.org/r/alice.eth"
}
```

### `POST /referral/link`

Link a referee to a referrer via referral code. Requires EIP-712 signature.

**Body:**

```json
{
  "wallet": "0x...",
  "signature": "0x...",
  "nonce": "0",
  "referralCode": "alice.eth",
  "deadline": "1738000000"
}
```

**Response:**

```json
{
  "success": true,
  "referral": {
    "referrerWallet": "0x...",
    "linkedAt": "2026-01-15T00:00:00Z",
    "gracePeriodEndsAt": "2026-01-22T00:00:00Z",
    "refereeBonusEndsAt": "2026-04-09T00:00:00Z",
    "status": "pending"
  }
}
```

### `GET /referral/validate/:code`

Validate a referral code before linking.

**Response:**

```json
{
  "valid": true,
  "referrerWallet": "0x...",
  "referrerEns": "alice.eth"
}
```

### `GET /referral/status`

Get referee's referral status (who referred them).

**Query params:** `walletAddress` (required)

**Response:**

```json
{
  "hasReferrer": true,
  "referrer": {
    "wallet": "0x...",
    "ensName": "alice.eth",
    "linkedAt": "2026-01-15T00:00:00Z",
    "gracePeriodEndsAt": "2026-01-22T00:00:00Z",
    "isInGracePeriod": true,
    "canChangeReferrer": true
  },
  "bonus": {
    "isActive": true,
    "endsAt": "2026-04-09T00:00:00Z",
    "weeksRemaining": 12,
    "bonusPercent": 10
  }
}
```

### `GET /referral/network`

Get referrer's network (list of referees).

**Query params:**

- `walletAddress` (required)
- `limit` (optional, default: 50)

**Response:**

```json
{
  "walletAddress": "0x...",
  "code": "alice.eth",
  "shareableLink": "https://glow.org/r/alice.eth",
  "stats": {
    "totalReferees": 5,
    "activeReferees": 3,
    "pendingReferees": 2,
    "totalPointsEarnedScaled6": "8234.000000",
    "thisWeekPointsScaled6": "847.000000"
  },
  "referees": [
    {
      "refereeWallet": "0x...",
      "ensName": "bob.eth",
      "status": "active",
      "linkedAt": "2026-01-10T00:00:00Z",
      "thisWeekPointsScaled6": "200.000000",
      "lifetimePointsScaled6": "1500.000000"
    }
  ]
}
```

### `POST /referral/change`

Change referrer within 7-day grace period. Requires EIP-712 signature.

**Body:**

```json
{
  "wallet": "0x...",
  "signature": "0x...",
  "nonce": "1",
  "newReferralCode": "bob.eth",
  "deadline": "1738000000"
}
```

### `POST /referral/feature-launch-seen`

Mark the feature launch modal as permanently dismissed.

**Body:**

```json
{
  "walletAddress": "0x..."
}
```

### `POST /referral/activation-seen`

Mark the activation celebration modal as seen.

**Body:**

```json
{
  "walletAddress": "0x..."
}
```

### `GET /referral/leaderboard`

Get referral leaderboard (for giveaway events).

**Query params:**

- `limit` (optional, default: 10)
- `sortBy` (optional: `points`, `network`, `hybrid`)

## Database Schema

### Core Tables

| Table                         | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `referrals`                   | Tracks referrer-referee relationships           |
| `referral_codes`              | Stores unique codes for each referrer wallet    |
| `referral_nonces`             | Nonce management for EIP-712 signature replay   |
| `referral_points_weekly`      | Weekly referral point calculations              |
| `referral_feature_launch_seen`| Tracks feature launch modal dismissal for users |

### Key Constraints

| Table            | Constraint                         | Purpose                                 |
| ---------------- | ---------------------------------- | --------------------------------------- |
| `referrals`      | `referee_wallet` UNIQUE            | One referrer per wallet                 |
| `referrals`      | `referral_code` INDEX (non-unique) | Multiple referees can use the same code |
| `referral_codes` | `wallet_address` UNIQUE            | One code per wallet                     |
| `referral_codes` | `code` UNIQUE                      | Each code must be globally unique       |

## Helper Functions

### `referral-code.ts`

| Function                  | Description                                   |
| ------------------------- | --------------------------------------------- |
| `getOrCreateReferralCode` | Creates or retrieves a wallet's referral code |

### `referral-linking.ts`

| Function       | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `linkReferrer` | Creates or updates referral link (use `requireExisting: true` to change) |

### `referral-validation.ts`

| Function                 | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `validateReferralLink`   | Validates code ownership, self-referral prevention |
| `isValidReferralCode`    | Validates code format (3-32 alphanumeric + dots)   |
| `getReferralNonce`       | Gets current nonce for wallet                      |
| `incrementReferralNonce` | Increments nonce after successful action           |
| `canClaimReferrer`       | Checks if wallet can claim/change referrer         |
| `canChangeReferrer`      | Alias for `canClaimReferrer`                       |

## Business Rules

### Referral Code Format

- 3-32 characters
- Alphanumeric plus dots (for ENS names)
- Case-insensitive matching
- Generated from ENS name if available, otherwise short hash

### Grace Period

- 7 days from initial link
- Allows referee to change referrer once
- After expiry, referrer is permanent

### Bonus Period

- 12 weeks from initial link
- Referee earns 10% bonus on base points
- Expires regardless of referrer changes

### Activation

- Referee must earn ≥100 base points **after linking** (pre-link points don't count)
- Status changes from "pending" to "active"
- Referrer starts earning share only after activation
- One-time 100pt bonus awarded to referee at activation

### Point Calculation

Referral points are calculated during the weekly Impact Score cron:

1. Get referee's base points (pre-multiplier)
2. Calculate referrer's tiered share (5-20%)
3. Calculate referee's 10% bonus (if in bonus period)
4. Store in `referral_points_weekly` table
5. Add to total Impact Score (NOT multiplied)

## Security

### EIP-712 Signatures

All state-changing actions require EIP-712 typed data signatures:

- `LinkReferral`: Links a referee to a referrer
- `ChangeReferrer`: Changes referrer within grace period

### Nonce Management

- Each wallet has a dedicated nonce counter
- Incremented after each successful action
- Prevents replay attacks

### Validation Layers

1. Signature verification (EIP-712)
2. Deadline expiration check
3. Nonce validation
4. Business rule validation (self-referral, grace period, etc.)

## Testing

See `tests/referral-router/README.md` for comprehensive test documentation.

```bash
# Run all referral tests
bun test tests/referral-router/

# Run specific test file
bun test tests/referral-router/referral-validation.test.ts
bun test tests/referral-router/referral-linking.test.ts
bun test tests/referral-router/referral-code.test.ts
bun test tests/referral-router/referral-points.test.ts
```
