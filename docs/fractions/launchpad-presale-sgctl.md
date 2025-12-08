# Launchpad-Presale (SGCTL) Fractions Feature

## Overview

This feature introduces a new fraction type called **"launchpad-presale"** that enables off-chain SGCTL token-based protocol deposit payments. This allows applications to have their protocol deposit paid through multiple fractions in different currencies (e.g., 30% SGCTL + 70% GLW), with the application only becoming a farm once the full USD amount is filled.

## Business Context

### Problem

Applications needed to support mixed payment methods where:

1. A portion of the protocol deposit can be paid in SGCTL (off-chain token)
2. The remaining portion can be paid in GLW (on-chain token)
3. The full protocol deposit amount (in USD terms) must be filled before the application becomes a farm

### Critical Constraints

**One Active GLW Fraction Rule**:

- An application can have **at most ONE active GLW (launchpad) fraction** at any time
- "Active" means: `status IN (draft, committed) AND expirationAt > now`
- To create a new GLW fraction, the previous one must be:
  - ✅ Expired (automatic via cron)
  - ✅ Cancelled (manual by Foundation Hub Manager)
  - ✅ Filled (automatic when all steps sold)
- **Why**: Prevents confusion, ensures clear price discovery, simplifies refund logic

**Multiple Presale Fractions**:

- Applications can have **multiple launchpad-presale fractions** (different weeks)
- Only **one presale can be COMMITTED at a time** (enforced at creation)
- Previous presales must be expired/cancelled before creating new ones

### Solution

Introduced a new fraction type `"launchpad-presale"` that:

- Uses SGCTL tokens (off-chain, handled by Control API)
- Allows partial fills (minStep = 1 instead of totalSteps)
- Expires on Tuesday at 12:00 PM EST (not 4 weeks like regular launchpad)
- Can be combined with regular GLW launchpad fractions

## Technical Changes

### 1. Constants (`src/constants/fractions.ts`)

#### Added Constants:

```typescript
export const SGCTL_TOKEN_ADDRESS = "0xSGCTL0000000000000000000000000000000000";
```

- **Purpose**: Recognizable fake address to identify SGCTL fractions in the database
- **Why**: Since SGCTL is off-chain, we needed a way to distinguish it from on-chain tokens

#### Added Function:

```typescript
export function getNextTuesdayNoonEST(): Date;
```

- **Purpose**: Calculate expiration date for launchpad-presale fractions
- **Behavior**: Always returns the next Tuesday at 12:00 PM EST
- **Timezone handling**: Converts EST to UTC for database storage
- **Edge case**: If it's currently Tuesday after noon, returns next week's Tuesday

### 2. Fraction Creation (`src/db/mutations/fractions/createFraction.ts`)

#### Extended Type Support:

- **Added**: `"launchpad-presale"` to the `CreateFractionParams.type` union
- **Behavior differences**:
  - **isCommittedOnChain**: Set to `true` immediately (no on-chain commit needed)
  - **status**: Set to `COMMITTED` immediately (skip DRAFT status)
  - **token**: Automatically set to `SGCTL_TOKEN_ADDRESS`
  - **owner**: Set to `createdBy` immediately
  - **expirationAt**: Calculated via `getNextTuesdayNoonEST()`

#### Why These Changes:

1. **No draft status**: Since SGCTL is off-chain, there's no on-chain commitment step
2. **Immediate committed status**: Makes fractions immediately available for purchase
3. **SGCTL token address**: Allows event listener to identify and handle differently
4. **Tuesday expiration**: Business requirement for presale timing

#### Additional Changes:

- **Bypass active fraction check**: For `launchpad-presale` fractions, the `hasActiveFractions` check is skipped since the foundation wallet may manage multiple active presales across different applications
- **Token assignment**: Token is now set based on fraction type (GLW for launchpad, USDC for mining-center, SGCTL for presale)

### 2b. Payment Currencies (`src/constants/payment-currencies.ts`) - NEW FILE

```typescript
import { PAYMENT_CURRENCIES as SDK_PAYMENT_CURRENCIES } from "@glowlabs-org/utils/browser";

export const PAYMENT_CURRENCIES = [
  ...SDK_PAYMENT_CURRENCIES,
  "SGCTL",
  "MIXED",
] as const;
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];
```

- **Purpose**: Extend SDK payment currencies to include internal-only currencies
- **"SGCTL"**: Used when application is funded purely by SGCTL presale
- **"MIXED"**: Used when application is funded by multiple token types

### 3. SGCTL Delegation Flow (Control → Hub Integration)

#### Implementation: Direct API Call (NOT Event-Based)

**Previous approach** (deprecated): Used `fraction.sold` events from Control API

**Current approach**: Control API directly calls Hub endpoint

- **Endpoint**: `POST /applications/delegate-sgctl`
- **Why direct call**: Synchronous validation allows Control to handle errors immediately
- **Authorization**: `x-api-key` header
- **Flow**:
  1. User signs delegation in Control frontend
  2. Control validates signature and locks SGCTL in `delegatedSgctlVaultBalance`
  3. Control calls Hub `POST /applications/delegate-sgctl`
  4. Hub validates fraction and records split
  5. Hub returns success/error synchronously
  6. If error, Control can refund immediately

#### Why This Change:

- **Synchronous validation**: Control knows immediately if delegation succeeded
- **Better UX**: User sees instant feedback instead of waiting for event processing
- **Error recovery**: Control can refund failed delegations before user leaves the page
- **Simpler architecture**: No event listener complexity for off-chain transactions

### 4. Cron Job & Refund Integration (`src/crons/expire-fractions/expireFractions.ts`)

#### Existing Cron (Enhanced):

- **Purpose**: Mark expired fractions of ALL types and trigger SGCTL refunds
- **Frequency**: Runs hourly
- **Logic**:
  1. Find all fractions where `expirationAt < now`
  2. Filter by `status === DRAFT or COMMITTED` (not already expired/filled)
  3. For each fraction, call `markFractionAsExpired(fractionId)`

#### Enhanced: `markFractionAsExpired()` & `markFractionAsCancelled()`

**Location**: `src/db/mutations/fractions/createFraction.ts`

**New behavior**:

1. Update fraction status to EXPIRED/CANCELLED
2. **If `type === "launchpad"` (GLW fraction) and `!isFilled`**: Application funding failed
   - Call `triggerSgctlRefundForApplication()` to refund ALL filled presale fractions
3. **If `type === "launchpad-presale"` expires**: Do nothing (wait for GLW outcome)
4. **On failure**: Record in `failedFractionOperations` for automatic retry (3 attempts)
5. **Slack notification**: Sent via `recordFailedFractionOperation` on failure

**Helper functions**:

```typescript
// Triggers refund for all presale fractions when GLW funding fails
async function triggerSgctlRefundForApplication(
  applicationId: string,
  triggeredByFractionId: string
) {
  // 1. Find all filled presale fractions for application
  // 2. Call triggerSgctlRefundForFraction() for each
}

// Calls Control API to refund a single presale fraction
async function triggerSgctlRefundForFraction(fraction: any) {
  // Calls Control API /delegate-sgctl/refund
  // Uses failedFractionOperations system for retry
}
```

**Refund Trigger Logic**:

- ❌ **NOT triggered** when presale fraction expires (users' SGCTL stays in delegatedVault)
- ✅ **Triggered** when GLW (launchpad) fraction expires/cancelled without filling
- ✅ **Triggered** when application is manually cancelled
- **Reason**: Presale delegations should only be refunded if the entire funding attempt fails

#### Why No Separate Cron:

- **Unified logic**: The existing cron already handles all fraction types
- **Automatic refunds**: Presale expiration triggers SGCTL refunds automatically
- **Retry safety**: Failed refunds are automatically retried (no data loss)
- **Additional safety**: When creating a GLW fraction, we auto-expire any active presale fractions (see section 8)

### 5. Public Routes Endpoints (`src/routers/applications-router/publicRoutes.ts`)

#### New Endpoint: `POST /applications/delegate-sgctl`

**Purpose**: Record SGCTL delegations from Control API

**Request Body**:

```typescript
{
  applicationId: string;
  fractionId: string;
  amount: string; // SGCTL atomic units (6 decimals)
  from: string; // Wallet address
  regionId: number;
  paymentDate: string; // ISO 8601
}
```

**Response**:

```typescript
{
  success: true;
}
```

**Authorization**: `x-api-key` header

**Validation** (in order):

1. Fraction type must be `"launchpad-presale"`
2. **Time-based**: `expirationAt > now` (prevents race with cron)
3. **Status-based**: `status === "committed"` (secondary check)
4. Token must be SGCTL
5. Amount must be ≥ one step price
6. Amount must be ≤ `exactAmount + (exactAmount * 1%)` (strict 1% tolerance)
7. Steps purchased must not exceed remaining capacity

**Defensive validation order**:

- ✅ Check time FIRST (cheaper, handles stale DB or cron delay)
- ✅ Check status SECOND (respects manual status changes)
- ✅ Both checks must pass (AND logic, not OR)

**Why**: Direct API call from Control (instead of events) for synchronous validation

### 6. Router Endpoints (`src/routers/fractions-router/fractionsRouter.ts`)

#### New Endpoint: `POST /fractions/create-launchpad-presale`

**Request Body**:

```typescript
{
  applicationId: string;
  sponsorSplitPercent: number; // 0-100
  totalSteps: number; // Min 1, allows partial fills
  stepPrice: string; // Price per step in SGCTL decimals (6 decimals like USDC)
}
```

**Response**:

```typescript
{
  success: true;
  fractionId: string;
  token: string; // SGCTL_TOKEN_ADDRESS
  expirationAt: Date; // Next Tuesday 12PM EST
  message: string;
}
```

**Authorization**: Only `FOUNDATION_HUB_MANAGER_WALLET` can create these fractions

**Why**: Centralizes presale creation to authorized personnel only

#### Updated Endpoint: `GET /fractions/available`

**Changes**:

- Added `"launchpad-presale"` to type filter options
- Returns `launchpadPresale` summary when no type filter specified
- Tracks SGCTL volume separately

**Response Structure** (no type filter):

```typescript
{
  launchpad: { summary, fractions },
  miningCenter: { summary, fractions },
  launchpadPresale: { summary, fractions } // NEW
}
```

### 6. Summary Endpoint (`src/db/queries/fractions/getFractionsSummary.ts`)

#### Added Tracking:

- **totalSgctlVolume**: Sum of all SGCTL sold (stepPrice × splitsSold)
- **launchpadPresaleContributors**: Unique buyer count for SGCTL fractions

#### Why:

- **Analytics**: Track SGCTL adoption separately from GLW/USDC
- **Metrics**: Monitor presale effectiveness
- **Reporting**: Dashboard can show all three volumes

### 7. Public Routes (`src/routers/applications-router/publicRoutes.ts`)

#### New Endpoint: `POST /applications/delegate-sgctl`

**Purpose**: Record SGCTL delegations from Control API

**Authorization**: `x-api-key` header (must match `GUARDED_API_KEY`)

**Request Body**:

```typescript
{
  applicationId: string; // Hub application UUID
  fractionId: string; // Fraction ID
  amount: string; // SGCTL amount in atomic units (6 decimals)
  from: string; // Delegator wallet (0x-prefixed)
  regionId: number; // Region ID where SGCTL is staked
  paymentDate: string; // ISO 8601 timestamp
}
```

**Validation**:

1. Fraction must exist and belong to the application
2. Fraction type must be `"launchpad-presale"`
3. Fraction status must be `"committed"` (not expired/filled/cancelled)
4. Fraction must not be expired (`expirationAt > now`)
5. Fraction token must be SGCTL
6. Amount must be ≥ one step price
7. Amount can be up to 1% more than `stepsPurchased * stepPrice` (overpayment tolerance)
8. Steps purchased must not exceed `remainingSteps`

**Amount Handling**:

- Uses **floor division**: `stepsPurchased = floor(amount / stepPrice)`
- Records **exact amount**: `stepsPurchased * stepPrice` (discards overpayment)
- Allows **1% overpayment tolerance** for rounding

**Flow**:

1. Validates fraction and calculates `stepsPurchased` via floor division
2. Generates synthetic transaction hash: `sgctl-delegate-{uuid}`
3. Calls `recordFractionSplit()` with exact amount (stepsPurchased × stepPrice)
4. Returns `{ success: true }`

**Note**: Unlike on-chain fractions, SGCTL delegations are NOT verified against blockchain. Control API is fully trusted.

#### Updated Endpoint: `GET /applications/sponsor-listings-applications`

**Changes**:

- Added `"launchpad-presale"` to type filter union
- Updated description to mention SGCTL presale fractions
- Existing logic already handles multiple fraction types per application

#### Updated Function: `completeApplicationAndCreateFarm()`

**Changes**:

- Extended `paymentCurrency` type to include "MIXED" and "SGCTL"
- Maps MIXED/SGCTL to "USDC" for external event emission (event schema doesn't support these values)
- **NEW**: After farm creation, calls Control API `/delegate-sgctl/finalize` for all presale fractions with sales
- **Finalize flow**:
  1. Query all presale fractions with `splitsSold > 0` (FILLED or EXPIRED with partial fills)
  2. POST to Control API with `{ fractionId, farmId }`
  3. On success: Mark presale fraction as FILLED (if not already)
  4. Run in background (non-blocking via `Promise.allSettled`)
  5. On failure: record in `failedFractionOperations` for automatic retry (3 attempts)
  6. Slack notification sent on failure (via `recordFailedFractionOperation`)

**Status transitions after finalization**:

- EXPIRED (partial fills) → FILLED ✅
- FILLED (fully sold) → FILLED (no change) ✅
- COMMITTED (edge case) → FILLED ✅

### 8. Multi-Fraction Aggregation (`src/db/queries/fractions/findFractionsByApplicationId.ts`)

#### New Functions:

```typescript
export async function getAllFractionsForApplication(applicationId: string);
export async function getTotalRaisedForApplication(
  applicationId: string
): Promise<{
  totalRaisedUSD: bigint;
  hasMultipleFractionTypes: boolean;
  fractionTypes: Set<string>;
}>;
```

- **`getAllFractionsForApplication`**: Returns all fractions for an application (excludes mining-center)
- **`getTotalRaisedForApplication`**: Calculates total USD raised across all fractions using `ApplicationPriceQuotes` for token→USD conversion

#### Why These Functions:

1. **Multi-currency support**: Need to aggregate value across GLW, USDC, and SGCTL fractions
2. **Farm creation gate**: Prevents premature farm creation until total raised >= protocol fee
3. **Payment currency detection**: Determines if "MIXED" currency should be used

#### Payment Currency Logic:

**Counts only fractions that contributed**:

- **Launchpad (GLW)**: Only counts if `status === FILLED` (all-or-nothing)
- **Launchpad-presale (SGCTL)**: Counts if `splitsSold > 0` (allows partial fills)

**Currency determination**:

```typescript
if (fractionTypes.size > 1) {
  paymentCurrency = "MIXED";  // Multiple token types contributed
} else if (only presale with sales) {
  paymentCurrency = "SGCTL";  // 100% SGCTL funding
} else if (only GLW filled) {
  paymentCurrency = "GLW";    // 100% GLW funding
}
```

**Examples**:

- SGCTL presale (5k sold) + GLW filled (5k) → `"MIXED"` ✅
- SGCTL presale (10k sold) + GLW draft (0 sales) → `"SGCTL"` ✅
- SGCTL presale (0 sales) + GLW filled (10k) → `"GLW"` ✅
- SGCTL presale (5k sold) + GLW committed but not filled → `"SGCTL"` ✅

### 9. GLW Fraction Validation (`src/routers/applications-router/applicationsRouter.ts`)

#### Updated Endpoint: `POST /applications/publish-application-to-auction`

**New Behavior**:

1. **CRITICAL: Enforces one active GLW fraction rule**

   - Checks for existing active GLW fraction (`findActiveFractionByApplicationId`)
   - If active committed GLW exists → **Rejects creation** with error
   - Only allows updating DRAFT fractions (before on-chain commitment)
   - Requires previous GLW to expire/be cancelled before creating new one

2. **Validates sponsorSplitPercent matches presale**

   - If a presale fraction has any sales, GLW must use the same sponsor split percentage

3. **Auto-expires any active presale fractions**

   - Ensures presale deadline doesn't interfere with GLW sales

4. **Validates remaining deficit**

   - Checks if application already fully funded → Rejects if `remainingDeficit <= 0`

5. **Calculates and validates GLW amount**

   - Converts new GLW fraction value to USD using price quotes
   - Validates that the GLW fraction covers the remaining deficit with ±$0.001 underfunding tolerance and allows up to 1% overage (to avoid impossible rounding targets)

6. **Returns 400 error** if:
   - Active committed GLW already exists
   - Application already fully funded
   - Amounts don't match remaining deficit
   - Sponsor split doesn't match presale

**Why**:

- Prevents over-funding or under-funding the protocol deposit
- Ensures consistent sponsor terms across all fractions for the same application
- **Prevents concurrent GLW fractions** (only one active at a time)
- Enforces sequential retry attempts (must cancel/expire before retry)

## Workflow: Mixed Payment Example

### Scenario: 30% SGCTL + 70% GLW

**Step 1: Create SGCTL Presale Fraction**

```
POST /fractions/create-launchpad-presale
{
  applicationId: "abc-123",
  sponsorSplitPercent: 50,
  totalSteps: 30000, // 30% of total steps (assuming 100k total)
  stepPrice: "1000000" // $1 in 6 decimals
}
```

- Expires next Tuesday 12PM EST
- Token: `0xSGCTL0000000000000000000000000000000000`
- Status: `COMMITTED` immediately
- minStep: 1 (allows partial fills)

**Step 2: Users Delegate SGCTL**

- User delegates SGCTL through Control API frontend
- Control API validates and locks SGCTL in `delegatedSgctlVaultBalance`
- Control API calls Hub `POST /applications/delegate-sgctl`
- Hub records split via `recordFractionSplit()` with synthetic transaction data
- `splitsSold` increments with each delegation

**Step 3: Tuesday 12PM EST**

- Cron job marks presale as `EXPIRED`
- Assume 25,000 steps sold (83% of presale target)
- **SGCTL remains locked** in delegatedVault (no refund yet)

**Step 4: Create GLW Fraction for Remainder**

```
POST /applications/publish-application-to-auction
{
  applicationId: "abc-123",
  sponsorSplitPercent: 50,
  totalSteps: 75000, // 70k (original plan) + 5k (unfilled SGCTL)
  stepPrice: "100000000000000000" // GLW price (18 decimals)
}
```

- Normal 4-week expiration
- On-chain commitment required
- Fills the remaining protocol deposit

**Step 5: GLW Fraction Fills**

- Users purchase GLW splits on-chain
- Once filled, `recordFractionSplit()` checks total raised >= protocol fee
- Application becomes a farm via `completeApplicationAndCreateFarm()`
- Hub calls Control `/delegate-sgctl/finalize` with farmId
- Control moves SGCTL from `delegatedSgctlVaultBalance` → `protocolDepositVaultBalance`
- Farm creation uses combined payment data from both fractions

## Key Specifications

### One Active GLW Fraction Per Application

**CRITICAL RULE**: An application can have at most **ONE active GLW (launchpad) fraction** at any time.

**Definition of "active"**:

```sql
status IN ('draft', 'committed')
AND expiration_at > NOW()
AND type = 'launchpad'
```

**Enforcement**:

- ✅ Validation in `POST /applications/publish-application-to-auction`
- ✅ Rejects creation if active committed GLW exists
- ✅ Allows updating DRAFT GLW (before on-chain commitment)
- ✅ Requires waiting for expiration OR manual cancellation before retry

**To retry funding with a new GLW fraction**:

1. **Wait for expiration** (automatic):

   - Current GLW expires after 4 weeks
   - Cron marks as EXPIRED
   - Refund check: If no SGCTL delegations OR you accept refunding them
   - Create new GLW fraction

2. **Manual cancellation** (Foundation Hub Manager only):

   - Foundation Hub Manager cancels active GLW via admin interface
   - Triggers refund of SGCTL delegations
   - Can then create new GLW fraction

3. **Best practice for retry**:
   - If GLW showing poor traction: Let it expire, accept SGCTL refund
   - Start fresh with new presale + GLW (better timing)
   - Don't try to "salvage" a failing attempt

**Why this rule**:

- Prevents user confusion (which fraction should I buy?)
- Ensures clear price discovery (one market price at a time)
- Simplifies refund logic (no concurrent GLW tracking needed)
- Enforces sequential attempts (learn from each attempt)

### SGCTL Delegation Amount Handling

**Problem**: Users may send slightly more or less than exact step multiples due to:

- UI rounding in Control frontend
- Wallet balance constraints
- Calculation precision differences

**Solution**: Floor division with 1% overpayment tolerance

**Algorithm**:

```typescript
// 1. Calculate steps (floor division)
stepsPurchased = floor(amount / stepPrice)

// 2. Reject if less than one step
if (stepsPurchased < 1) → reject

// 3. Calculate exact required amount
exactAmount = stepsPurchased * stepPrice

// 4. Allow up to 1% overpayment
maxAllowed = exactAmount + (exactAmount / 100)
if (amount > maxAllowed) → reject

// 5. Record exact amount (discard overpayment)
recordFractionSplit({ amount: exactAmount, ... })
```

**Examples** (Step price: 10 SGCTL = 10000000 atomic units):

| User Sends  | Steps Purchased | Exact Amount | Recorded  | Overpayment | Overpayment % | Result                 |
| ----------- | --------------- | ------------ | --------- | ----------- | ------------- | ---------------------- |
| 9.99 SGCTL  | 0               | N/A          | N/A       | N/A         | N/A           | ❌ Rejected (< 1 step) |
| 10 SGCTL    | 1               | 10 SGCTL     | 10 SGCTL  | 0 SGCTL     | 0%            | ✅ Accepted            |
| 10.09 SGCTL | 1               | 10 SGCTL     | 10 SGCTL  | 0.09 SGCTL  | 0.9%          | ✅ Accepted            |
| 10.10 SGCTL | 1               | 10 SGCTL     | 10 SGCTL  | 0.10 SGCTL  | 1.0%          | ✅ Accepted (at limit) |
| 10.11 SGCTL | 1               | 10 SGCTL     | 10 SGCTL  | 0.11 SGCTL  | 1.1%          | ❌ Rejected (>1%)      |
| 11 SGCTL    | 1               | 10 SGCTL     | N/A       | 1 SGCTL     | 10%           | ❌ Rejected (>1%)      |
| 100 SGCTL   | 10              | 100 SGCTL    | 100 SGCTL | 0 SGCTL     | 0%            | ✅ Accepted            |
| 101 SGCTL   | 10              | 100 SGCTL    | 100 SGCTL | 1 SGCTL     | 1.0%          | ✅ Accepted (at limit) |
| 102 SGCTL   | 10              | 100 SGCTL    | N/A       | 2 SGCTL     | 2.0%          | ❌ Rejected (>1%)      |
| 200 SGCTL   | 20              | 200 SGCTL    | 200 SGCTL | 0 SGCTL     | 0%            | ✅ Accepted            |
| 202 SGCTL   | 20              | 200 SGCTL    | 200 SGCTL | 2 SGCTL     | 1.0%          | ✅ Accepted (at limit) |
| 203 SGCTL   | 20              | 200 SGCTL    | N/A       | 3 SGCTL     | 1.5%          | ❌ Rejected (>1%)      |

**Why exact amount recording**:

- Ensures `splitsSold` counter matches actual value contributed
- Prevents protocol deposit calculations from including overpayments
- Simplifies refund logic (refund exactly what was recorded)

### Fraction Types Comparison

| Property                   | Launchpad                 | Mining-Center         | Launchpad-Presale     |
| -------------------------- | ------------------------- | --------------------- | --------------------- |
| Token                      | GLW (on-chain)            | USDC (on-chain)       | SGCTL (off-chain)     |
| Min Steps                  | totalSteps                | totalSteps            | 1                     |
| Max Steps                  | totalSteps                | totalSteps            | totalSteps            |
| Expiration                 | 4 weeks                   | Next Saturday 2PM ET  | Next Tuesday 12PM EST |
| On-chain Commit            | Yes                       | Yes                   | No (immediate)        |
| Initial Status             | DRAFT                     | DRAFT                 | COMMITTED             |
| Partial Fills              | No                        | No                    | Yes                   |
| Verification               | On-chain                  | On-chain              | Trust Control API     |
| **Max Active Per App**     | **1** (enforced)          | 1 (enforced)          | 1 (enforced)          |
| **Concurrent Allowed**     | **No** (must wait)        | No (must wait)        | No (must wait)        |
| **Retry After Expiration** | **Yes** (sequential only) | Yes (sequential only) | Yes (can create new)  |

**Key Rule**: Only **ONE active fraction per type per application**. To retry:

- Wait for current fraction to expire (automatic)
- OR manually cancel it (Foundation Hub Manager only)
- THEN create new fraction

### Status Transitions

**Launchpad-Presale States**:

```
COMMITTED → FILLED (if all steps sold before expiration)
COMMITTED → EXPIRED (if Tuesday 12PM EST passes)

After expiration:
EXPIRED → FILLED (if GLW funding succeeds and finalization completes)
EXPIRED → EXPIRED (if GLW funding fails - stays expired, SGCTL refunded)
```

**Important lifecycle details**:

1. **Tuesday noon**: Presale marked as EXPIRED (even if partially filled)
2. **SGCTL locked**: Delegations remain in `delegatedVault` (not refunded)
3. **GLW fills**: Presale updated to FILLED + SGCTL finalized
4. **GLW fails**: Presale stays EXPIRED + SGCTL refunded

**Why status changes to FILLED**:

- Reflects that SGCTL was successfully finalized to protocol deposit
- Matches behavior of GLW fractions (filled = contributed to farm)
- Allows queries like "all filled fractions" to include presales
- Accurate for analytics (presale contributed even though it expired before farm creation)

### Token Address Convention

- **GLW**: Actual on-chain contract address (from `forwarderAddresses.GLW`)
- **USDC**: Actual on-chain contract address (from `forwarderAddresses.USDC`)
- **SGCTL**: `0xSGCTL0000000000000000000000000000000000` (fake, recognizable address)

### Authorization

- **Create launchpad-presale**: Only `FOUNDATION_HUB_MANAGER_WALLET`
- **Create launchpad**: Application owner (or admins/GCAs)
- **Create mining-center**: Only `FOUNDATION_HUB_MANAGER_WALLET`

## Error Handling & Retry System

### Failed Operations Integration

**Table**: `failedFractionOperations`

**Operations tracked**:

- `"refund"`: Failed SGCTL refund callbacks to Control API
- `"finalize"`: Failed SGCTL finalize callbacks to Control API

**Retry behavior**:

- **Max retries**: 3 attempts per operation
- **Automatic retry**: Handled by existing retry service (`src/services/retryFailedOperations.ts`)
- **Manual retry**: Admins can manually trigger retry from failed operations table
- **Slack notifications**: Sent automatically on failure and permanent failure

**Recorded data**:

```typescript
{
  fractionId: string;
  operationType: "refund" | "finalize";
  eventType: "sgctl.delegation.refund" | "sgctl.delegation.finalize";
  eventPayload: {
    fractionId: string;
    applicationId: string;
    farmId?: string; // For finalize only
    statusCode?: number;
    errorText?: string;
  };
  errorMessage: string;
  errorStack: string;
  retryCount: number;
  status: "pending" | "retrying" | "failed" | "resolved";
}
```

## Remaining TODOs

### Critical (Must Do) - ✅ COMPLETED

1. **Cron Job Setup** ✅

   - [x] Existing `expireFractions()` cron already handles all fraction types
   - [x] Runs hourly - no changes needed
   - [x] Auto-expire presale when creating GLW fraction (additional safety)
   - [x] Integrated SGCTL refund callback in `markFractionAsExpired()`

2. **Database Migration** ✅

   - [x] No migration needed - uses existing `fractions` table structure

3. **Testing**
   - [ ] Test SGCTL fraction creation
   - [ ] Test SGCTL split recording from Control API events
   - [ ] Test expiration cron on Tuesday noon EST
   - [ ] Test mixed payment flow (SGCTL + GLW)

### Important (Should Do) - ✅ COMPLETED

4. **Application Completion Logic** ✅

   - [x] Added `getTotalRaisedForApplication()` to calculate USD value across all fractions
   - [x] `recordFractionSplit` now checks `totalRaisedUSD >= requiredProtocolFee` before creating farm
   - [x] Uses `ApplicationPriceQuotes` for accurate token→USD conversion
   - [x] Uses "MIXED" payment currency when multiple fraction types contributed
   - [x] Finalize callback integrated in `completeApplicationAndCreateFarm()`
   - [x] Calls Control API `/finalize` for all filled presale fractions
   - [x] Retry system integration via `failedFractionOperations`

5. **Query Optimization**

   - [ ] Add database index on `(type, status, expirationAt)` for cron performance
   - [ ] Add index on `(applicationId, type)` for multi-fraction queries

6. **Frontend Support**
   - [ ] Update TypeScript types in frontend to include `"launchpad-presale"`
   - [ ] Add UI for creating launchpad-presale fractions
   - [ ] Display SGCTL fractions differently (show partial fill progress)
   - [ ] Show combined funding status for applications with multiple fractions

### Nice to Have

8. **Documentation**
   - [x] This document updated with implementation details
   - [ ] API documentation for Control API event payload structure

## Edge Cases & Considerations

### Handled Edge Cases

1. **Duplicate Delegation Calls**

   - ✅ Control API manages idempotency (only calls Hub once per delegation)
   - ✅ Database transaction wraps split recording + counter increment
   - ✅ If fraction already filled, `recordFractionSplit` returns early without error

2. **Race Conditions**

   - ✅ Database transaction wraps split recording + counter increment
   - ✅ Safe WHERE clauses prevent modifying filled fractions
   - ✅ Remaining capacity checked before recording split

3. **Amount Validation**

   - ✅ Floor division prevents fractional steps
   - ✅ Strict 1% overpayment tolerance (of exact amount, not user amount)
   - ✅ Exact amount recorded (stepsPurchased × stepPrice)
   - ✅ Remaining steps validated before recording

4. **Expiration Boundary Race Condition**

   - ✅ **Double validation** in `/delegate-sgctl`: Check both `expirationAt > now` AND `status === COMMITTED`
   - ✅ **Time checked first** (cheaper, handles cron delay)
   - ✅ **Status checked second** (respects manual status changes)
   - **Scenario**: User delegates at 11:59:59, request hits Hub at 12:00:01
     - Even if cron hasn't run yet, time-based check rejects it ✅
     - Even if DB is stale, status check catches it ✅

5. **Multiple GLW Fractions (Retry Attempts)**

   - ✅ **Refund gated** by checking for other active GLW fractions
   - ✅ **Logic**: Only refund presale if NO active GLW (draft/committed, not expired) exists
   - **Scenario**: GLW #1 expires → GLW #2 created (retry)
     - GLW #1 expiration checks for active GLW → Finds GLW #2 → NO refund ✅
     - GLW #2 expires → No active GLW found → Triggers refund ✅
   - **File**: `src/db/mutations/fractions/createFraction.ts` (triggerSgctlRefundForApplication)

6. **Timezone Handling**

   - ✅ Tuesday noon EST calculation accounts for DST
   - ✅ Dates stored as UTC in database

7. **Authorization**

   - ✅ Only FOUNDATION_HUB_MANAGER can create presale fractions
   - ✅ `delegate-sgctl` endpoint secured with API key
   - ✅ Same authorization checks as other fraction types

8. **Sponsor Split Consistency**

   - ✅ GLW fraction must use same sponsorSplitPercent as presale (if presale had sales)
   - ✅ Validation error returned if mismatch detected

9. **Control API Callback Failures**

   - ✅ Refund/finalize failures recorded in `failedFractionOperations`
   - ✅ Automatic retry (3 attempts) via existing retry service
   - ✅ Slack notifications sent on failure and permanent failure
   - ✅ Manual retry capability for admins
   - ✅ Idempotent callbacks (Control handles duplicate calls safely)

10. **Presale Expiration Does NOT Trigger Refund**

    - ✅ When presale (launchpad-presale) expires → Only status updated to EXPIRED
    - ✅ SGCTL remains in `delegatedVault` (not refunded)
    - ✅ Refund only triggered when GLW (launchpad) fraction fails (expires/cancelled)
    - ✅ Allows GLW fraction to complete after presale expires
    - **Why**: Multi-step funding allows presale to expire while GLW is still being sold

11. **Refund Triggered by GLW Failure**

    - ✅ GLW (launchpad) expires/cancelled → Calls `triggerSgctlRefundForApplication()`
    - ✅ Queries ALL filled presale fractions for the application
    - ✅ Refunds each presale fraction via Control API
    - ✅ Safe even if presale expired weeks ago
    - **Why**: Ensures SGCTL delegators get refunded when funding attempt fails

12. **Presale Fully Funds Application**

- ✅ If presale fully funds protocol deposit → Farm created when presale fills
- ✅ Cannot create GLW fraction → Validation rejects with `remainingDeficit <= 0`
- ✅ Prevents unnecessary GLW fractions when SGCTL alone is sufficient
- **File**: `src/routers/applications-router/applicationsRouter.ts` (publish-application-to-auction)

11. **Expiration Boundary Race Condition**

- ✅ `/delegate-sgctl` validates **time THEN status** (defensive ordering)
- ✅ Rejects if `now > expirationAt` even if status not yet updated
- ✅ Rejects if `status !== COMMITTED` even if time check passes
- **Scenario**: Delegation arrives at 12:00:01, cron runs at 12:05
  - Time check rejects immediately (cron delay doesn't matter) ✅
- **File**: `src/routers/applications-router/publicRoutes.ts` (delegate-sgctl endpoint)

12. **Sequential GLW Attempts (No Concurrent Active Fractions)**

- ✅ **Validation prevents** creating GLW #2 while GLW #1 is active (committed)
- ✅ Must wait for GLW #1 to expire/be cancelled before creating GLW #2
- ✅ Refund check: Only triggers if NO other active GLW exists (defensive programming)
- **Normal flow**: GLW #1 expires → Refund triggered → Create GLW #2 (after refund)
- **Edge case prevention**: Even if validation bypassed, refund check provides safety
- **File**:
  - Validation: `src/routers/applications-router/applicationsRouter.ts` (publish-application-to-auction)
  - Refund check: `src/db/mutations/fractions/createFraction.ts` (triggerSgctlRefundForApplication)

## Monitoring & Observability

### Slack Notifications

**Channel**: `#devs`

**Notifications sent for**:

1. Fraction filled (existing)
2. ⚠️ SGCTL refund failed (new)
3. ⚠️ SGCTL finalize failed (new)
4. 🚨 Failed operation alert (existing, via `failedFractionOperations`)
5. ✅ Failed operation resolved (existing, after successful retry)
6. ❌ Operations permanently failed (existing, after max retries)

**Example Alert** (SGCTL Refund Failed):

```
⚠️ *SGCTL Refund Failed*

*Fraction ID:* 0x123abc...
*Application ID:* app-xyz
*Status Code:* 500
*Error:* Internal Server Error
*Environment:* production

_Action required: Manual refund may be needed for SGCTL delegations._
```

### Database Monitoring

**Tables to watch**:

- `fractions`: Track presale creation/fill rates
- `fraction_splits`: Monitor SGCTL delegation volume
- `failed_fraction_operations`: Alert on `operationType: "refund" | "finalize"`

**Key queries**:

```sql
-- Pending SGCTL refunds/finalizations
SELECT * FROM failed_fraction_operations
WHERE operation_type IN ('refund', 'finalize')
  AND status = 'pending';

-- Failed permanently (need manual intervention)
SELECT * FROM failed_fraction_operations
WHERE operation_type IN ('refund', 'finalize')
  AND status = 'failed';
```

### ✅ Previously Critical Gaps - NOW RESOLVED

1.  **Premature Farm Creation in `recordFractionSplit`** ✅ FIXED

    - **Solution**: Added `getTotalRaisedForApplication()` in `findFractionsByApplicationId.ts`
    - **Implementation**: `recordFractionSplit` now calls this function and only creates farm if `totalRaisedUSD >= requiredProtocolFee`
    - **File**: `src/db/mutations/fractions/createFraction.ts` (lines 502-518)

2.  **Missing "Mixed Currency" Handover** ✅ FIXED

    - **Solution**: Added `PaymentCurrency` type that includes "MIXED" and "SGCTL"
    - **Implementation**: When `hasMultipleFractionTypes` is true, uses "MIXED" as payment currency
    - **Event Mapping**: Maps MIXED/SGCTL to "USDC" for external events (event schema doesn't support MIXED)
    - **Files**: `src/constants/payment-currencies.ts`, `src/routers/applications-router/publicRoutes.ts`

3.  **Sequential Fraction Creation Validation** ✅ FIXED

    - **Solution**: Added GLW amount validation in `publish-application-to-auction`
    - **Implementation**: Calculates remaining deficit, converts new GLW fraction to USD, enforces ±$0.001 underfunding tolerance and allows up to 1% overage
    - **File**: `src/routers/applications-router/applicationsRouter.ts` (lines 2004-2056)

4.  **Application Completion Logic** ✅ FIXED

    - **Solution**: Same as #1 - uses `getTotalRaisedForApplication()` for multi-fraction aggregation
    - **Implementation**: Converts all token amounts to USD using `ApplicationPriceQuotes`
    - **File**: `src/db/queries/fractions/findFractionsByApplicationId.ts`

5.  **Price Volatility** ✅ HANDLED

    - **Solution**: Uses `ApplicationPriceQuotes` table for all USD conversions
    - **Implementation**: `getTotalRaisedForApplication()` fetches latest price quotes for the application

6.  **Concurrent Presale Creation** ✅ FIXED

    - **Solution**: Added explicit check in `create-launchpad-presale` endpoint
    - **Implementation**: Queries for existing active presale fractions before creating new one
    - **File**: `src/routers/fractions-router/fractionsRouter.ts` (lines 3251-3270)

7.  **Expiration Timing Precision** ✅ FIXED

    - **Solution**: Auto-expire presale fractions when creating GLW fraction
    - **Implementation**: `publish-application-to-auction` calls `markFractionAsExpired()` for any active presale
    - **File**: `src/routers/applications-router/applicationsRouter.ts` (lines 1986-2001)
    - **Note**: Hourly cron still runs as backup for natural expiration

8.  **Fraction Refunds** ✅ FIXED

    - **Solution**: Hub calls Control `/delegate-sgctl/refund` when GLW funding fails
    - **Trigger**: Only when GLW (launchpad) fraction expires/cancelled without filling
    - **Implementation**: Integrated in `markFractionAsExpired()` and `markFractionAsCancelled()`
    - **Logic**: GLW failure → Refund ALL filled presale fractions for the application
    - **Retry**: Uses `failedFractionOperations` system (3 attempts)
    - **File**: `src/db/mutations/fractions/createFraction.ts`
    - **Important**: Presale expiration does NOT trigger refunds (SGCTL stays locked)

9.  **SGCTL Delegation Recording** ✅ FIXED

    - **Solution**: New endpoint `POST /applications/delegate-sgctl`
    - **Implementation**: Control calls Hub directly (synchronous validation)
    - **Amount handling**: Floor division with 1% overpayment tolerance
    - **File**: `src/routers/applications-router/publicRoutes.ts`

10. **Farm Finalization Callbacks** ✅ FIXED

    - **Solution**: Hub calls Control `/delegate-sgctl/finalize` after farm creation
    - **Implementation**: Integrated in `completeApplicationAndCreateFarm()`
    - **Retry**: Uses `failedFractionOperations` system (3 attempts)
    - **File**: `src/routers/applications-router/publicRoutes.ts`

11. **Payment Currency Detection Bug** ✅ FIXED

    - **Problem**: `hasMultipleFractionTypes` was counting ALL fraction types, not just those that contributed
    - **Example bug**: SGCTL presale (10k sold) + GLW draft (0 sales) → incorrectly detected as "MIXED"
    - **Solution**: Only count fractions that contributed:
      - Launchpad: Only if `status === FILLED`
      - Launchpad-presale: Only if `splitsSold > 0`
    - **Result**: 100% SGCTL → `"SGCTL"`, 100% GLW → `"GLW"`, both → `"MIXED"`
    - **File**: `src/db/queries/fractions/findFractionsByApplicationId.ts`

## Data Model

### Fraction Record Example (SGCTL)

**After Presale Expires (Before GLW Outcome)**:

```typescript
{
  id: "0x123abc...",
  applicationId: "app-xyz",
  type: "launchpad-presale",
  token: "0xSGCTL0000000000000000000000000000000000",
  owner: "0x5252...", // FOUNDATION_HUB_MANAGER
  createdBy: "0x5252...",
  sponsorSplitPercent: 50,
  stepPrice: "1000000", // $1 in 6 decimals
  totalSteps: 30000, // Max $30k in SGCTL
  splitsSold: 25000, // $25k sold (partial fill)
  nonce: 1,
  status: "expired", // Expired on Tuesday
  isCommittedOnChain: true,
  isFilled: false, // Not yet - waiting for GLW outcome
  expirationAt: "2025-12-02T17:00:00Z", // Tuesday 12PM EST in UTC
  createdAt: "2025-11-25T10:00:00Z",
  updatedAt: "2025-12-02T17:05:00Z", // Updated when marked expired
  committedAt: "2025-11-25T10:00:00Z",
  filledAt: null
}
```

**After GLW Fills and Finalization**:

```typescript
{
  id: "0x123abc...",
  applicationId: "app-xyz",
  type: "launchpad-presale",
  token: "0xSGCTL0000000000000000000000000000000000",
  owner: "0x5252...",
  createdBy: "0x5252...",
  sponsorSplitPercent: 50,
  stepPrice: "1000000",
  totalSteps: 30000,
  splitsSold: 25000,
  nonce: 1,
  status: "filled", // ✅ Updated from "expired" after finalization
  isCommittedOnChain: true,
  isFilled: true, // ✅ Updated to true after finalization
  expirationAt: "2025-12-02T17:00:00Z",
  createdAt: "2025-11-25T10:00:00Z",
  updatedAt: "2025-12-10T20:00:00Z", // ✅ Updated when marked filled
  committedAt: "2025-11-25T10:00:00Z",
  filledAt: "2025-12-10T20:00:00Z" // ✅ Set when marked filled
}
```

### Fraction Splits Example (SGCTL)

```typescript
{
  id: 123,
  fractionId: "0x123abc...",
  transactionHash: "sgctl-delegate-550e8400-e29b-41d4-a716-446655440000", // Synthetic UUID
  blockNumber: "0", // Not applicable for off-chain
  logIndex: 0,
  creator: "0x5252...", // fraction.owner (FOUNDATION_HUB_MANAGER)
  buyer: "0x789def...", // User who delegated (from Control API call)
  step: "1000000", // $1 in 6 decimals (from fraction.step)
  amount: "5000000000", // Exact amount: stepsPurchased * step (NOT user's overpayment)
  stepsPurchased: 5000, // floor(userAmount / step)
  timestamp: 1732550400, // Unix timestamp from paymentDate
  rewardScore: null, // Not used for presale
  createdAt: "2025-11-25T10:30:00Z"
}
```

**Key differences from on-chain splits**:

- `transactionHash`: Synthetic UUID format `sgctl-delegate-{uuid}`
- `amount`: Always equals `stepsPurchased * step` (exact, not user overpayment)
- `blockNumber`: Always "0" (off-chain)
- `logIndex`: Always 0 (off-chain)

## API Flow Diagram

### Delegation Flow (User → Control → Hub)

```
User Wallet
    │
    │ 1. Sign EIP-712 DelegateSgctl
    │    { nonce, amount, applicationId, fractionId, deadline }
    ▼
Control API
    │
    │ 2. Validate signature & lock SGCTL
    │    totalStaked → delegatedVault
    │
    │ 3. POST /applications/delegate-sgctl
    │    { applicationId, fractionId, amount, from, regionId, paymentDate }
    ▼
Hub Backend (this repo)
    │
    │ 4. Validate fraction (type, status, capacity)
    │ 5. Calculate stepsPurchased (floor division, 1% tolerance)
    │ 6. recordFractionSplit({ amount: exactAmount, ... })
    │ 7. Increment splitsSold counter
    │
    └─► Return { success: true }
```

### Finalize Flow (Farm Created → Control)

```
Hub Backend
    │
    │ recordFractionSplit() detects fraction filled
    │ totalRaisedUSD >= requiredProtocolFee
    │
    │ completeApplicationAndCreateFarm()
    │     │
    │     │ 1. Create farm with farmId
    │     │
    │     │ 2. Query filled presale fractions
    │     ▼
    │     POST /delegate-sgctl/finalize (background)
    │         { fractionId, farmId }
    │
    ▼
Control API
    │
    │ 3. Move SGCTL: delegatedVault → protocolDepositVault
    │ 4. Create stakedControlProtocolDepositEvents
    │ 5. Update delegation status: pending → finalized
    │
    └─► Return { success: true, processed: N }
         │
         ▼
    Hub Backend (on success)
         │
         │ 6. Mark presale fraction as FILLED
         │    (if status was EXPIRED or COMMITTED)
         │
         └─► Presale status: EXPIRED/COMMITTED → FILLED

On failure:
  → Hub records in failedFractionOperations
  → Automatic retry (3 attempts)
  → Slack notification sent
```

### Refund Flow (GLW Fraction Fails → Refund Presale)

**IMPORTANT**: Refunds are NOT triggered when presale expires. They're only triggered when the GLW (launchpad) fraction fails to fill.

```
Hub Backend
    │
    │ GLW (launchpad) fraction expires/cancelled without filling
    │     │
    │     │ markFractionAsExpired(glwFractionId)
    │     │     │
    │     │     │ 1. Update GLW fraction status → EXPIRED/CANCELLED
    │     │     │ 2. Check: type === "launchpad" && !isFilled ✅
    │     │     │ 3. triggerSgctlRefundForApplication(applicationId)
    │     │     │
    │     │     │ 4. Query all FILLED presale fractions for application
    │     │     ▼
    │     │     For each presale fraction:
    │     │         POST /delegate-sgctl/refund
    │     │             { fractionId: presaleFractionId }
    │     │
    ▼
Control API
    │
    │ 5. Move SGCTL: delegatedVault → totalStaked (per wallet)
    │ 6. Update delegation status: pending → refunded
    │ 7. SGCTL available for user operations again
    │
    └─► Return { success: true, processed: N }

On failure:
  → Hub records in failedFractionOperations
  → Automatic retry (3 attempts)
  → Slack notification sent

Note: When presale expires on Tuesday:
  → Presale marked as EXPIRED
  → SGCTL stays in delegatedVault (NOT refunded yet)
  → Waiting for GLW fraction outcome
```

## Integration Points

### Control API → Hub Backend

**Endpoint**: `POST /applications/delegate-sgctl`

**Authorization**: `x-api-key` header (must match `GUARDED_API_KEY`)

**Request Body**:

```typescript
{
  applicationId: string; // Hub application UUID
  fractionId: string; // Fraction ID for the active listing
  amount: string; // SGCTL amount in atomic units (6 decimals)
  from: string; // Delegator wallet address (0x-prefixed, lowercase)
  regionId: number; // Region ID where SGCTL is staked
  paymentDate: string; // ISO 8601 timestamp of delegation
}
```

**Response (200 OK)**:

```typescript
{
  success: true;
}
```

**Error Response (4xx)**:

```typescript
"Error message string";
```

**Behavior**:

- Validates fraction state and capacity
- Calculates `stepsPurchased = floor(amount / stepPrice)`
- Allows up to 1% overpayment tolerance
- Records split with exact amount (`stepsPurchased * stepPrice`)
- Generates synthetic transaction: `sgctl-delegate-{uuid}`
- Increments `splitsSold` counter

### Hub Backend → Control API

**These endpoints are called BY the Hub TO notify Control of lifecycle events:**

#### 1. POST `/delegate-sgctl/finalize`

**When**: Application funding succeeds and farm is created

**Triggered by**: `completeApplicationAndCreateFarm()` after farm creation

**Headers**: `x-api-key: GUARDED_API_KEY`

**Request**:

```json
{
  "fractionId": "fraction-uuid",
  "farmId": "farm-uuid"
}
```

**Flow**:

- Called for ALL filled `launchpad-presale` fractions for the application
- Runs in background (non-blocking)
- On failure: recorded in `failedFractionOperations` (3 retry attempts)
- Idempotent: safe to call multiple times

#### 2. POST `/delegate-sgctl/refund`

**When**: Fraction expires or is cancelled

**Triggered by**: `markFractionAsExpired()` and `markFractionAsCancelled()`

**Headers**: `x-api-key: GUARDED_API_KEY`

**Request**:

```json
{
  "fractionId": "fraction-uuid"
}
```

**Flow**:

- Called when presale fraction expires (cron) or is manually cancelled
- Only called if `type === "launchpad-presale"` and `!isFilled`
- On failure: recorded in `failedFractionOperations` (3 retry attempts)
- Idempotent: safe to call multiple times

### Hub Backend → Frontend

**New API Endpoints**:

- `POST /fractions/create-launchpad-presale` - Create SGCTL presale
- `GET /fractions/available?type=launchpad-presale` - List available presales
- `GET /fractions/summary` - Returns `totalSgctlVolume` and `launchpadPresaleContributors`

**Modified Endpoints**:

- `GET /applications/sponsor-listings-applications?type=launchpad-presale` - Filter for presales

## Complete Flow Example

### Real-world Scenario: 40% SGCTL + 60% GLW

> Quick demo: `bun run scripts/simulate-sgctl-mixed-flow.ts --scenario=<name>` (default `mixed-success`).  
> The simulator seeds a disposable application, hits the real Hub API endpoints, and spins up a local Control API stub so finalize/refund callbacks succeed.
>
> | Scenario name   | Behavior covered (matches sections below)                      |
> | --------------- | -------------------------------------------------------------- |
> | `mixed-success` | 40% SGCTL + 60% GLW (this section)                             |
> | `refund`        | Funding Failure Path (GLW expires → SGCTL refunded)            |
> | `sgctl-only`    | Happy Path / Presale Fully Funds Application                   |
> | `zero-presale`  | Zero Fill Success Path                                         |
> | `multi-retry`   | Sequential GLW Attempts (one-active-GLW rule + retry workflow) |
> | `validation`    | Delegate guardrails (under/over-pay, capacity, auth checks)    |

**Initial State**:

- Application needs $10,000 protocol deposit
- GCA creates presale for $4,000 SGCTL (40%)
- Plan to create GLW fraction for $6,000 (60%)

**Timeline**:

**Day 1 (Monday) - Create Presale**

```bash
# Foundation Hub Manager creates presale
POST /fractions/create-launchpad-presale
{
  "applicationId": "app-123",
  "sponsorSplitPercent": 50,
  "totalSteps": 4000,
  "stepPrice": "1000000"  # $1 in 6 decimals
}

# Response:
{
  "fractionId": "frac-abc",
  "expirationAt": "2024-12-10T17:00:00Z"  # Next Tuesday 12PM EST
}
```

**Days 1-7 - Users Delegate SGCTL**

```bash
# User 1 delegates 1000 SGCTL
Control: POST /applications/delegate-sgctl
Hub validates → Records split (1000 steps)
Hub: splitsSold = 1000

# User 2 delegates 1500.05 SGCTL
Control: POST /applications/delegate-sgctl
Hub: floor(1500.05 / 1) = 1500 steps
Hub: Records 1500 SGCTL (0.05 discarded)
Hub: splitsSold = 2500

# ... more delegations ...
# Total: 3500 steps sold ($3,500)
```

**Day 8 (Tuesday 12PM EST) - Presale Expires**

```bash
# Cron runs
expireFractions() → markFractionAsExpired("frac-abc")
  ↓
Presale status: COMMITTED → EXPIRED
  ↓
⚠️ NO REFUND TRIGGERED (presale expiration doesn't trigger refunds)
  ↓
Users' 3500 SGCTL remains in delegatedVault
  ↓
Waiting for GLW fraction outcome...
```

**Important**: At this point, users' SGCTL is NOT refunded. It stays locked in `delegatedVault` until:

- ✅ **Success case**: GLW fraction fills → SGCTL finalized to protocol deposit
- ❌ **Failure case**: GLW fraction expires → SGCTL refunded to users

**Day 8 (Afternoon) - Create GLW Fraction**

```bash
# User creates GLW fraction for remainder
POST /applications/publish-application-to-auction
{
  "applicationId": "app-123",
  "sponsorSplitPercent": 50,  # Must match presale!
  "totalSteps": 6500,  # $6k (planned) + $0.5k (unfilled SGCTL)
  "stepPrice": "1000000000000000000"  # GLW price in 18 decimals
}

# Hub validates:
# - totalRaisedUSD = $3,500 (from SGCTL)
# - remainingDeficit = $10,000 - $3,500 = $6,500
# - newFractionUSD = 6500 GLW * glwPrice ≈ $6,500 ✅
# - Auto-expires presale fraction (already expired)
```

**Days 8-35 - GLW Fraction Fills**

```bash
# Users purchase GLW on-chain
# ... on-chain transactions ...
# Total: 6500 steps sold

# Last purchase fills the fraction:
recordFractionSplit() → fraction filled
  ↓
getTotalRaisedForApplication()
  ↓
totalRaisedUSD = $10,000 ✅
  ↓
completeApplicationAndCreateFarm()
  ↓
farmId = "farm-xyz" created
  ↓
POST /delegate-sgctl/finalize (background)
{ fractionId: "frac-abc", farmId: "farm-xyz" }
  ↓
Control: delegatedVault (3500) → protocolDepositVault (3500)
Control: Links SGCTL to farm-xyz
  ↓
Hub: Mark presale fraction "frac-abc" as FILLED
     (status: EXPIRED → FILLED, isFilled: false → true)
```

**Result (Success)**:

- Farm created with ID `farm-xyz`
- Payment currency: `"MIXED"`
- SGCTL delegators earn rewards from farm-xyz
- GLW delegators earn rewards from farm-xyz
- All sponsor rewards use 50% split

---

### Alternative: GLW Fraction Fails (Refund Scenario)

**Same setup through Day 8 (presale expires with 3500 SGCTL delegated)**

**Days 8-35 - GLW Fraction Partially Fills**

```bash
# Users purchase GLW on-chain
# Total: Only 2000 steps sold (not enough)
# GLW fraction expires after 4 weeks
```

**Day 36 - GLW Fraction Expires**

```bash
# Cron runs
expireFractions() → markFractionAsExpired("glw-frac-xyz")
  ↓
GLW fraction status: COMMITTED → EXPIRED
  ↓
Check: type === "launchpad" && !isFilled ✅
  ↓
triggerSgctlRefundForApplication("app-123", "glw-frac-xyz")
  ↓
Query filled presale fractions for app-123 → Found ["frac-abc"]
  ↓
For each presale:
  POST /delegate-sgctl/refund { fractionId: "frac-abc" }
    ↓
  Control: delegatedVault (3500) → totalStaked (3500 returned to users)
    ↓
  Control: Update delegation status: pending → refunded
```

**Result (Failure)**:

- No farm created
- Application remains in `waitingForPayment` status
- SGCTL delegations refunded (users can use SGCTL again)
- GLW purchases can be claimed as refunds via smart contract
- GCA can create new presale/GLW fractions to try again

**Key insight**: Presale SGCTL stays locked even after presale expires, giving the GLW fraction a chance to succeed. Only when the full funding attempt fails (GLW expires) are presale delegations refunded.

## Testing Checklist

### Unit Tests Needed

- [ ] `getNextTuesdayNoonEST()` timezone handling

  - Test on Monday (returns tomorrow)
  - Test on Tuesday before noon (returns today)
  - Test on Tuesday after noon (returns next week)
  - Test during DST transition

- [ ] `createFraction()` with type `"launchpad-presale"`

  - Verify token set to SGCTL address
  - Verify immediate committed status
  - Verify Tuesday expiration calculation

- [ ] `getTotalRaisedForApplication()` calculation

  - Verify USD conversion using ApplicationPriceQuotes
  - Verify handles multiple fraction types
  - Verify excludes mining-center fractions
  - Verify handles partial fills correctly

- [ ] `expireFractions()` cron (existing)
  - Verify handles all fraction types including launchpad-presale
  - Only marks committed/draft status
  - Only marks expired dates

### Integration Tests Needed

**Delegation Flow**:

- [ ] POST `/delegate-sgctl` with valid data → Verify split recorded and counter increments
- [ ] POST `/delegate-sgctl` with amount < step price → Should be rejected
- [ ] POST `/delegate-sgctl` with 1% overpayment → Should succeed, record exact amount
- [ ] POST `/delegate-sgctl` with >1% overpayment → Should be rejected
- [ ] POST `/delegate-sgctl` with insufficient capacity → Should be rejected
- [ ] POST `/delegate-sgctl` with wrong fraction type → Should be rejected
- [ ] POST `/delegate-sgctl` with expired fraction → Should be rejected
- [ ] POST `/delegate-sgctl` without API key → Should return 401

**Expiration & Refund**:

- [ ] Create SGCTL presale → Let expire → Cron marks as expired → Verify NO refund called
- [ ] Create SGCTL presale → Expires → Create GLW → GLW expires unfilled → Verify refund called for presale
- [ ] GLW expires → Refund callback fails → Recorded in `failedFractionOperations` → Retry succeeds
- [ ] GLW expires → Refund callback fails 3 times → Marked as permanently failed → Slack notification sent

**Finalization**:

- [ ] Create SGCTL + GLW fractions → Both fill → Farm created → Finalize called
- [ ] Finalize callback fails → Recorded in `failedFractionOperations` → Retry succeeds
- [ ] Finalize callback fails 3 times → Marked as permanently failed → Slack notification sent

**Mixed Payment Flow**:

- [ ] Create SGCTL → Partial fill → Expires → SGCTL locked → Create GLW → GLW fills → Farm created → SGCTL finalized
- [ ] Create GLW fraction → Verify USD validation respects ±$0.001 underfunding tolerance and ≤1% overage
- [ ] Create GLW fraction with different sponsorSplitPercent → Should be rejected
- [ ] Concurrent presale creation → Second attempt should be rejected

**100% Presale Funding**:

- [ ] Create presale for full protocol deposit → Presale fills completely → Farm created automatically
- [ ] Try to create GLW fraction after presale fills → Should be rejected (remainingDeficit = 0)
- [ ] Presale fills → Verify finalize callback triggered → Presale marked as FILLED

**Race Conditions**:

- [ ] User delegates at 11:59:59 EST, request arrives at 12:00:01 → Should be rejected (time-based check)
- [ ] Cron marks presale EXPIRED, then delegate call arrives → Should be rejected (status check)

**Sequential GLW Attempts (One Active GLW Rule)**:

- [ ] Create GLW #1 (draft) → Commit on-chain → Try to create GLW #2 → Should be rejected (active committed GLW exists)
- [ ] GLW #1 committed and active → Foundation cancels GLW #1 → GLW #1 marked CANCELLED → Create GLW #2 → Should succeed
- [ ] GLW #1 expires naturally → Cron marks EXPIRED → Create GLW #2 → Should succeed (GLW #1 no longer active)
- [ ] GLW #1 expires → Refund triggered → SGCTL refunded → Create GLW #2 → Succeeds but starts fresh (no SGCTL to finalize)
- [ ] GLW #1 draft (not committed) → Try to create GLW #2 → Updates GLW #1 instead of creating new (allowed for draft)

### Manual Testing Scenarios

1. **Happy Path: Full Presale Fill (100% SGCTL Funding)**

   - Create presale with 10k steps @ $1 = $10k total (covers full protocol deposit)
   - Users delegate 10k SGCTL through Control API
   - Presale marks as FILLED (splitsSold === totalSteps)
   - Farm created automatically (totalRaisedUSD >= requiredProtocolFee)
   - Control receives `/finalize` → SGCTL moved to protocolDepositVault
   - **GLW fraction creation blocked** (remainingDeficit = 0)

2. **Partial Fill Success Path**

   - Create presale with 10k steps @ $1 each
   - Users delegate 6k SGCTL (6k steps filled)
   - Tuesday passes, cron marks presale as EXPIRED
   - **SGCTL stays in delegatedVault** (not refunded yet)
   - Create GLW fraction for $4k remaining (unfilled presale amount)
   - GLW fills completely
   - Farm created → Control receives `/finalize` → SGCTL moved to protocolDepositVault

3. **Zero Fill Success Path**

   - Create presale with 10k steps
   - No delegations
   - Tuesday passes, cron marks presale as EXPIRED
   - Create GLW fraction for full 10k
   - GLW fills
   - Farm created → No SGCTL to finalize (presale had no sales)

4. **Presale Fully Funds Application** (100% SGCTL)

   - Create presale with 10k steps @ $1 each = $10k total
   - Users delegate full 10k SGCTL (all steps sold)
   - **Presale marked as FILLED** (before Tuesday)
   - **Farm created immediately** (totalRaisedUSD >= requiredProtocolFee)
   - Control receives `/finalize` → SGCTL moved to protocolDepositVault
   - **Cannot create GLW fraction** (remainingDeficit = 0, validation rejects)

5. **Funding Failure Path** (Refund Triggered)

   - Create presale, 6k steps filled, expires
   - **SGCTL stays in delegatedVault** (6k SGCTL locked)
   - Create GLW for 4k remaining
   - GLW fraction expires unfilled (only 2k sold)
   - GLW expiration triggers `markFractionAsExpired(glw-frac-id)`
   - Hub checks for other active GLW fractions → None found ✅
   - Hub calls `/refund` for presale fraction
   - Control refunds 6k SGCTL to delegators (delegatedVault → totalStaked)
   - GLW buyers claim on-chain refunds via smart contract
   - Application remains in `waitingForPayment`
   - GCA can retry with new fractions next week

6. **Multi-Retry Path (Sequential GLW Attempts)**

**IMPORTANT: Only ONE active GLW fraction allowed per application**

**Scenario**: Presale filled with 6k SGCTL, need to retry GLW funding

**Option A: Wait for Natural Expiration** (Higher Risk)

```
1. Presale: 6k SGCTL filled, expires → SGCTL locked in delegatedVault
2. GLW #1: Created for 4k → Only 1k sold
3. GLW #1 expires (4 weeks pass)
4. Cron marks GLW #1 as EXPIRED
5. Refund check: No other active GLW → ⚠️ Triggers refund immediately
6. SGCTL refunded to users
7. Must start over with new presale + GLW
```

**Option B: Manual Cancellation + Quick Recreation** (Recommended)

```
1. Presale: 6k SGCTL filled, expires → SGCTL locked
2. GLW #1: Created for 4k → Only 1k sold after 3 weeks
3. Foundation Hub Manager sees low traction
4. **Manually cancel GLW #1** via admin interface
5. GLW #1 cancellation triggers refund check → No active GLW → Refunds SGCTL ❌
6. Must start over with new presale

⚠️ Current limitation: Cannot create GLW #2 before cancelling GLW #1
    (validation prevents multiple active GLW fractions)
```

**Option C: Let It Expire, Accept Refund** (Clean Slate)

```
1. Presale expires with 6k SGCTL
2. GLW #1 expires with poor sales
3. SGCTL refunded to delegators
4. GCA creates NEW presale #2 (fresh Tuesday deadline)
5. Users re-delegate SGCTL
6. GLW #2 created for remaining amount
7. Better chance of success with fresh timing
```

**Why this constraint exists**:

- ✅ Prevents price confusion (which GLW fraction to buy?)
- ✅ Simplifies refund logic (only check for active GLW)
- ✅ Enforces sequential attempts (not parallel)
- ✅ Clearer for users (one funding option at a time)

## Security Considerations

### Trust Model

**SGCTL Events**: Fully trusted from Control API

- No on-chain verification
- No signature validation on events

### Authorization

**Presale Creation**: Only FOUNDATION_HUB_MANAGER

- Prevents unauthorized SGCTL fraction creation
- Centralizes presale management

### Data Integrity

**Immutability**: Filled fractions cannot be modified

- Enforced via `validateFractionCanBeModified()`
- Safe WHERE clauses in all updates

## Future Enhancements

3. **Refund Tracking**

   - Listen to `sgctl.fraction.refunded` events from Control API
   - Store refund records in database
   - Provide refund status endpoint

4. **Multi-currency Support**

   - Extend to other off-chain tokens beyond SGCTL
   - Generic off-chain token handler

5. **Cancellation Flow**
   - Allow manual cancellation of presale before expiration
   - Emit events to Control API for refund processing

## Deployment Notes

### Environment Variables

**Required for SGCTL delegation**:

- `GUARDED_API_KEY` - Shared secret for Hub ↔ Control API communication
- `CONTROL_API_URL` - Control API base URL (for finalize/refund callbacks)
- `SLACK_BOT_TOKEN` - For Slack notifications on failures (recommended)

**Existing (unchanged)**:

- `RABBITMQ_ADMIN_USER` - For event emission
- `RABBITMQ_ADMIN_PASSWORD` - For event emission
- `NODE_ENV` - Environment detection

### Database

**No migration required** - Uses existing `fractions` table structure

**Recommended indexes** (for performance):

```sql
CREATE INDEX idx_fractions_type_status_expiration
  ON fractions(type, status, expiration_at);

CREATE INDEX idx_fractions_application_type
  ON fractions(application_id, type);
```

### Cron Configuration

**No changes needed** - The existing `expireFractions()` cron already handles all fraction types:

```typescript
// Existing cron - runs every hour, handles ALL fraction types
schedule("0 * * * *", () => expireFractions());
```

**Additional safety**: When creating a GLW fraction via `publish-application-to-auction`, any active presale fractions are auto-expired to prevent timing issues.

## API Contract Reference

### Hub Endpoints (Called BY Control)

#### POST /applications/delegate-sgctl

**Auth**: `x-api-key` header  
**Called by**: Control API when user delegates SGCTL  
**Purpose**: Record delegation as fraction split

**Request**:

```json
{
  "applicationId": "uuid",
  "fractionId": "fraction-id",
  "amount": "10500000",
  "from": "0x1234...",
  "regionId": 1,
  "paymentDate": "2024-01-01T00:00:00.000Z"
}
```

**Success Response (200)**:

```json
{ "success": true }
```

**Error Responses**:

- 400: Validation errors (amount, capacity, fraction state)
- 401: Invalid/missing API key
- 404: Fraction or application not found

### Control Endpoints (Called BY Hub)

#### POST /delegate-sgctl/finalize

**Auth**: `x-api-key` header  
**Called by**: Hub when farm is created  
**Purpose**: Move SGCTL to protocol deposit vault

**Request**:

```json
{
  "fractionId": "fraction-id",
  "farmId": "farm-uuid"
}
```

**Success Response (200)**:

```json
{
  "success": true,
  "fractionId": "fraction-id",
  "processed": 12
}
```

#### POST /delegate-sgctl/refund

**Auth**: `x-api-key` header  
**Called by**: Hub when fraction expires/cancelled  
**Purpose**: Return SGCTL to user's staked pool

**Request**:

```json
{
  "fractionId": "fraction-id"
}
```

**Success Response (200)**:

```json
{
  "success": true,
  "fractionId": "fraction-id",
  "processed": 5
}
```

## Summary

This feature enables flexible protocol deposit payments through off-chain SGCTL presales that can be combined with on-chain GLW fractions. The implementation uses direct API calls instead of events for better synchronous validation and error handling, integrates with the existing retry infrastructure for resilience, and provides comprehensive monitoring through Slack notifications.

**Key Innovation**: Multiple fractions can now contribute to a single application's protocol deposit, opening possibilities for creative funding models and mixed token payments.

**Architecture Highlights**:

- **Direct API calls** (Control → Hub → Control) provide better UX than event-driven architecture, with immediate validation feedback and automatic retry on failures.
- **Delayed refund logic**: Presale SGCTL remains locked even after presale expires, giving the GLW fraction time to complete. Only when GLW funding fails are presale delegations refunded.
- **Atomic finalization**: All presale fractions finalized together when farm is created, ensuring consistent state.

### Implementation Status: ✅ COMPLETE

**Backend Changes Complete**:

- ✅ Constants and helper functions for SGCTL and Tuesday expiration
- ✅ Fraction creation with immediate COMMITTED status for presale
- ✅ **Direct API endpoint** (`POST /applications/delegate-sgctl`) instead of event listener
- ✅ Existing cron handles all fraction types (no separate cron needed)
- ✅ New endpoint for creating launchpad-presale fractions (`POST /fractions/create-launchpad-presale`)
- ✅ Multi-fraction USD aggregation using ApplicationPriceQuotes
- ✅ Farm creation gated by total raised >= protocol fee
- ✅ "MIXED" payment currency for multi-fraction funding
- ✅ Strict GLW validation against remaining deficit
- ✅ Auto-expire presale when creating GLW fraction
- ✅ Prevent concurrent presale fractions per application
- ✅ Foundation wallet can bypass owner checks for presale creation
- ✅ Sponsor split consistency validation between presale and GLW fractions
- ✅ **SGCTL refund callback** in `markFractionAsExpired()` and `markFractionAsCancelled()`
- ✅ **SGCTL finalize callback** in `completeApplicationAndCreateFarm()`
- ✅ **Retry system integration** via `failedFractionOperations` (3 attempts)
- ✅ **Slack notifications** for refund/finalize failures
- ✅ **1% overpayment tolerance** with exact amount recording
- ✅ **Floor division** for steps purchased calculation
- ✅ **Mark presale as FILLED** after successful finalization (EXPIRED → FILLED)
- ✅ **Query by splitsSold > 0** for finalize/refund (handles partial fills)
- ✅ **Prevent GLW creation** when presale fully funds application (remainingDeficit <= 0)
- ✅ **Auto-farm creation** when presale fills and covers full protocol deposit
- ✅ **One active GLW rule** enforced in publish-application-to-auction (prevents concurrent GLW fractions)
- ✅ **Refund safety check** queries for other active GLW before refunding (defensive programming)
- ✅ **Payment currency logic fixed** - Only counts FILLED launchpad + any presale with sales (not draft/expired with 0 sales)
- ✅ **Retry handlers added** for refund/finalize operations in retryFailedOperations service

**Remaining**:

- ⏳ Frontend UI for creating/displaying presale fractions
- ⏳ Integration testing with Control API
- ⏳ Database indexes for performance optimization
