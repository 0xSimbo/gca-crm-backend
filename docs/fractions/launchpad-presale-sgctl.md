# Launchpad-Presale (SGCTL) Fractions Feature

## Overview

This feature introduces a new fraction type called **"launchpad-presale"** that enables off-chain SGCTL token-based protocol deposit payments. This allows applications to have their protocol deposit paid through multiple fractions in different currencies (e.g., 30% SGCTL + 70% GLW), with the application only becoming a farm once the full USD amount is filled.

## Business Context

### Problem

Applications needed to support mixed payment methods where:

1. A portion of the protocol deposit can be paid in SGCTL (off-chain token)
2. The remaining portion can be paid in GLW (on-chain token)
3. The full protocol deposit amount (in USD terms) must be filled before the application becomes a farm

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

### 3. Event Listener (`src/services/eventListener.ts`)

#### Modified Handler:

- **Event**: `fraction.sold`
- **Change**: Added SGCTL token detection before on-chain verification

```typescript
const isSGCTLFraction =
  event.payload.token?.toLowerCase() === SGCTL_TOKEN_ADDRESS.toLowerCase();

if (!isSGCTLFraction) {
  // Verify on-chain transaction
} else {
  // Skip verification for off-chain SGCTL
}
```

#### Why This Change:

- **Off-chain nature**: SGCTL transactions don't exist on-chain, so verification would fail
- **Control API trust**: Events come from Control API which has already validated the SGCTL payment
- **Unified flow**: Allows reusing the same event type for both on-chain and off-chain fractions

### 4. Cron Job (`src/crons/expire-fractions/expireFractions.ts`)

#### Existing Cron (No Changes Needed):

- **Purpose**: Mark expired fractions of ALL types
- **Frequency**: Runs hourly
- **Logic**:
  1. Find all fractions where `expirationAt < now`
  2. Filter by `status === DRAFT or COMMITTED` (not already expired/filled)
  3. Mark each as `EXPIRED`

#### Why No Separate Cron:

- **Unified logic**: The existing cron already handles all fraction types without filtering by type
- **Simplicity**: No need to maintain separate cron jobs for different expiration times
- **Additional safety**: When creating a GLW fraction, we auto-expire any active presale fractions (see section 8)

### 5. Router Endpoints (`src/routers/fractions-router/fractionsRouter.ts`)

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

#### Updated Endpoint: `GET /applications/sponsor-listings-applications`

**Changes**:

- Added `"launchpad-presale"` to type filter union
- Updated description to mention SGCTL presale fractions
- Existing logic already handles multiple fraction types per application

#### Updated Function: `completeApplicationAndCreateFarm()`

**Changes**:

- Extended `paymentCurrency` type to include "MIXED" and "SGCTL"
- Maps MIXED/SGCTL to "USDC" for external event emission (event schema doesn't support these values)

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

### 9. GLW Fraction Validation (`src/routers/applications-router/applicationsRouter.ts`)

#### Updated Endpoint: `POST /applications/publish-application-to-auction`

**New Behavior**:

1. **Validates sponsorSplitPercent matches presale** - If a presale fraction has any sales, the GLW fraction must use the same sponsor split percentage
2. Auto-expires any active launchpad-presale fractions for the application
3. Calculates remaining protocol fee deficit (`requiredProtocolFee - totalRaisedUSD`)
4. Converts new GLW fraction value to USD using price quotes
5. **Strictly validates** that GLW fraction covers exactly the remaining deficit (±$0.001 tolerance)
6. Returns 400 error if amounts or sponsor split don't match

**Why**:

- Prevents over-funding or under-funding the protocol deposit
- Ensures consistent sponsor terms across all fractions for the same application

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

**Step 2: Users Purchase SGCTL**

- Control API processes SGCTL payments
- Control API emits `fraction.sold` events
- Backend records splits without on-chain verification
- `splitsSold` increments with each purchase

**Step 3: Tuesday 12PM EST**

- Cron job marks presale as `EXPIRED`
- Assume 25,000 steps sold (83% of presale target)

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
- Once filled, application becomes a farm
- Farm creation uses combined payment data from both fractions

## Key Specifications

### Fraction Types Comparison

| Property        | Launchpad      | Mining-Center        | Launchpad-Presale     |
| --------------- | -------------- | -------------------- | --------------------- |
| Token           | GLW (on-chain) | USDC (on-chain)      | SGCTL (off-chain)     |
| Min Steps       | totalSteps     | totalSteps           | 1                     |
| Max Steps       | totalSteps     | totalSteps           | totalSteps            |
| Expiration      | 4 weeks        | Next Saturday 2PM ET | Next Tuesday 12PM EST |
| On-chain Commit | Yes            | Yes                  | No (immediate)        |
| Initial Status  | DRAFT          | DRAFT                | COMMITTED             |
| Partial Fills   | No             | No                   | Yes                   |
| Verification    | On-chain       | On-chain             | Trust Control API     |

### Status Transitions

**Launchpad-Presale States**:

```
COMMITTED → FILLED (if all steps sold)
COMMITTED → EXPIRED (if Tuesday 12PM EST passes)
```

### Token Address Convention

- **GLW**: Actual on-chain contract address (from `forwarderAddresses.GLW`)
- **USDC**: Actual on-chain contract address (from `forwarderAddresses.USDC`)
- **SGCTL**: `0xSGCTL0000000000000000000000000000000000` (fake, recognizable address)

### Authorization

- **Create launchpad-presale**: Only `FOUNDATION_HUB_MANAGER_WALLET`
- **Create launchpad**: Application owner (or admins/GCAs)
- **Create mining-center**: Only `FOUNDATION_HUB_MANAGER_WALLET`

## Remaining TODOs

### Critical (Must Do) - ✅ COMPLETED

1. **Cron Job Setup** ✅

   - [x] Existing `expireFractions()` cron already handles all fraction types
   - [x] Runs hourly - no changes needed
   - [x] Auto-expire presale when creating GLW fraction (additional safety)

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

1. **Duplicate Event Processing**

   - ✅ Event listener checks for existing splits before recording
   - ✅ Uses transaction hash + log index for idempotency

2. **Race Conditions**

   - ✅ Database transaction wraps split recording + counter increment
   - ✅ Safe WHERE clauses prevent modifying filled fractions

3. **Timezone Handling**

   - ✅ Tuesday noon EST calculation accounts for DST
   - ✅ Dates stored as UTC in database

4. **Authorization**

   - ✅ Only FOUNDATION_HUB_MANAGER can create presale fractions
   - ✅ Same authorization checks as other fraction types

5. **Sponsor Split Consistency**
   - ✅ GLW fraction must use same sponsorSplitPercent as presale (if presale had sales)
   - ✅ Validation error returned if mismatch detected

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

    - **Solution**: Added strict validation in `publish-application-to-auction`
    - **Implementation**: Calculates remaining deficit, converts new GLW fraction to USD, validates they match (±$0.001 tolerance)
    - **File**: `src/routers/applications-router/applicationsRouter.ts` (lines 2004-2056)

4.  **Application Completion Logic** ✅ FIXED

    - **Solution**: Same as #1 - uses `getTotalRaisedForApplication()` for multi-fraction aggregation
    - **Implementation**: Converts all token amounts to USD using `ApplicationPriceQuotes`
    - **File**: `src/db/queries/fractions/findFractionsByApplicationId.ts`

5.  **Failed Fraction Chain** ⚠️ DEFERRED

    - Control API handles SGCTL refunds externally
    - **Future**: Add event listener for `sgctl.fraction.refunded` events

6.  **Price Volatility** ✅ HANDLED

    - **Solution**: Uses `ApplicationPriceQuotes` table for all USD conversions
    - **Implementation**: `getTotalRaisedForApplication()` fetches latest price quotes for the application

7.  **Concurrent Presale Creation** ✅ FIXED

    - **Solution**: Added explicit check in `create-launchpad-presale` endpoint
    - **Implementation**: Queries for existing active presale fractions before creating new one
    - **File**: `src/routers/fractions-router/fractionsRouter.ts` (lines 3251-3270)

8.  **Expiration Timing Precision** ✅ FIXED

    - **Solution**: Auto-expire presale fractions when creating GLW fraction
    - **Implementation**: `publish-application-to-auction` calls `markFractionAsExpired()` for any active presale
    - **File**: `src/routers/applications-router/applicationsRouter.ts` (lines 1986-2001)
    - **Note**: Hourly cron still runs as backup for natural expiration

9.  **Fraction Refunds** ⚠️ DEFERRED

    - Control API handles refunds externally
    - **Future**: Add event listener for `sgctl.fraction.refunded` events

## Data Model

### Fraction Record Example (SGCTL)

```typescript
{
  id: "0x123abc...", // Generated fraction ID
  applicationId: "app-xyz",
  type: "launchpad-presale",
  token: "0xSGCTL0000000000000000000000000000000000",
  owner: "0x5252...", // FOUNDATION_HUB_MANAGER
  createdBy: "0x5252...",
  sponsorSplitPercent: 50,
  stepPrice: "1000000", // $1 in 6 decimals
  totalSteps: 30000, // Max $30k in SGCTL
  splitsSold: 25000, // $25k sold
  nonce: 1,
  status: "expired", // Or "committed" if still active
  isCommittedOnChain: true, // Always true for presale
  isFilled: false, // True only if splitsSold === totalSteps
  expirationAt: "2025-12-02T17:00:00Z", // Tuesday 12PM EST in UTC
  createdAt: "2025-11-25T10:00:00Z",
  updatedAt: "2025-12-02T17:05:00Z",
  committedAt: "2025-11-25T10:00:00Z", // Same as createdAt
  filledAt: null
}
```

### Fraction Splits Example (SGCTL)

```typescript
{
  id: 123,
  fractionId: "0x123abc...",
  transactionHash: "sgctl-tx-hash-from-control-api",
  blockNumber: "0", // Not applicable for off-chain
  logIndex: 0,
  creator: "0x5252...", // FOUNDATION_HUB_MANAGER
  buyer: "0x789def...", // User who purchased
  step: "1000000", // $1 in 6 decimals
  amount: "5000000000", // $5000 in 6 decimals
  stepsPurchased: 5000, // 5000 steps
  timestamp: 1732550400,
  rewardScore: null, // Not used for presale
  createdAt: "2025-11-25T10:30:00Z"
}
```

## Integration Points

### Control API → CRM Backend

**Event**: `fraction.sold` (v2-alpha)

**Payload** (SGCTL specific):

```typescript
{
  fractionId: string;
  transactionHash: string; // Off-chain identifier
  blockNumber: string; // "0" or off-chain block
  logIndex: number;
  creator: string; // FOUNDATION_HUB_MANAGER
  buyer: string; // User wallet
  step: string; // Price per step (6 decimals)
  amount: string; // Total amount paid (6 decimals)
  timestamp: number; // Unix timestamp
  token: "0xSGCTL0000000000000000000000000000000000";
}
```

**Expected Behavior**: Backend records split without on-chain verification

### CRM Backend → Frontend

**New API Endpoints**:

- `POST /fractions/create-launchpad-presale` - Create SGCTL presale
- `GET /fractions/available?type=launchpad-presale` - List available presales
- `GET /fractions/summary` - Returns `totalSgctlVolume` and `launchpadPresaleContributors`

**Modified Endpoints**:

- `GET /applications/sponsor-listings-applications?type=launchpad-presale` - Filter for presales

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

- [ ] Create SGCTL fraction → Record split from Control API → Verify counter increments
- [ ] Create SGCTL fraction → Let expire → Cron marks as expired
- [ ] Create SGCTL + GLW fractions → Both fill → Application becomes farm
- [ ] Create SGCTL → Partial fill → Expires → Create GLW → GLW fills → Farm created
- [ ] Invalid SGCTL event (wrong token) → Should be rejected
- [ ] Create GLW fraction → Verify strict USD validation against remaining deficit
- [ ] Create GLW fraction with different sponsorSplitPercent → Should be rejected
- [ ] Concurrent presale creation → Second attempt should be rejected

### Manual Testing Scenarios

1. **Happy Path: Full Presale Fill**

   - Create presale with 10k steps
   - Control API emits 10k worth of splits
   - Fraction marks as FILLED
   - Application can create farm

2. **Partial Fill Path**

   - Create presale with 10k steps
   - Control API emits 6k worth of splits
   - Tuesday passes, cron marks as EXPIRED
   - Manually create GLW fraction for 4k remaining
   - GLW fills
   - Application becomes farm

3. **Zero Fill Path**

   - Create presale with 10k steps
   - No purchases
   - Tuesday passes, cron marks as EXPIRED
   - Manually create GLW fraction for 10k
   - GLW fills
   - Application becomes farm

4. **Failed Chain Path**
   - Create presale, 6k fills, expires
   - Create GLW for 4k remaining
   - GLW expires unfilled
   - Control API refunds SGCTL buyers and GLW buyers
   - Application remains in waitingForPayment untill we do it all over again the weeek following

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

No new environment variables required. Uses existing:

- `RABBITMQ_ADMIN_USER`
- `RABBITMQ_ADMIN_PASSWORD`
- `SLACK_BOT_TOKEN` (optional, for notifications)

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

### Monitoring

**Key Metrics to Watch**:

- Presale creation rate
- SGCTL volume vs. GLW volume
- Presale fill rates (0%, partial, 100%)
- Expiration processing latency
- Failed operations in `failed_fraction_operations` table

## Summary

This feature enables flexible protocol deposit payments through off-chain SGCTL presales that can be combined with on-chain GLW fractions. The implementation reuses existing infrastructure (fractions table, event system, router patterns) with minimal changes, making it a clean extension rather than a major refactor.

**Key Innovation**: Multiple fractions can now contribute to a single application's protocol deposit, opening possibilities for creative funding models and mixed token payments.

### Implementation Status: ✅ COMPLETE

**Backend Changes Complete**:

- ✅ Constants and helper functions for SGCTL and Tuesday expiration
- ✅ Fraction creation with immediate COMMITTED status for presale
- ✅ Event listener skips on-chain verification for SGCTL fractions
- ✅ Existing cron handles all fraction types (no separate cron needed)
- ✅ New endpoint for creating launchpad-presale fractions
- ✅ Multi-fraction USD aggregation using ApplicationPriceQuotes
- ✅ Farm creation gated by total raised >= protocol fee
- ✅ "MIXED" payment currency for multi-fraction funding
- ✅ Strict GLW validation against remaining deficit
- ✅ Auto-expire presale when creating GLW fraction
- ✅ Prevent concurrent presale fractions per application
- ✅ Foundation wallet can bypass owner checks for presale creation
- ✅ Sponsor split consistency validation between presale and GLW fractions

**Remaining**:

- ⏳ Frontend UI for creating/displaying presale fractions
- ⏳ Integration testing with Control API
- ⏳ Database indexes for performance optimization
- ⏳ Refund event tracking (future enhancement)
