# `/sponsor-listings-applications` Endpoint Documentation

## Overview

The `/sponsor-listings-applications` endpoint returns applications with active fractions available for purchase on the Glow sponsorship marketplace. This endpoint supports both **launchpad** fractions (pre-payment applications) and **mining-center** fractions (completed applications).

## Endpoint Details

- **Path**: `/applications/sponsor-listings-applications`
- **Method**: `GET`
- **Auth**: Public (no authentication required)

## Query Parameters

| Parameter         | Type                                        | Required | Description                                     |
| ----------------- | ------------------------------------------- | -------- | ----------------------------------------------- |
| `type`            | `"launchpad"` \| `"mining-center"`          | No       | Filter by fraction type. Default: `"launchpad"` |
| `zoneId`          | `number`                                    | No       | Filter by specific zone ID                      |
| `sortBy`          | `string`                                    | No       | Sort field (see sorting options below)          |
| `sortOrder`       | `"asc"` \| `"desc"`                         | No       | Sort direction. Default: `"desc"`               |
| `paymentCurrency` | `"USDG"` \| `"USDC"` \| `"GLW"` \| `"GCTL"` | No       | Filter by payment currency availability         |

### Sorting Options

- `publishedOnAuctionTimestamp` - Sort by when the fraction was created
- `sponsorSplitPercent` - Sort by sponsor split percentage
- `finalProtocolFee` - Sort by protocol fee amount
- `paymentCurrency` - Sort by price (when currency specified) or number of available currencies

## Fraction Types

### Launchpad Fractions (`type=launchpad`)

- **Status**: `waiting-for-payment`
- **Purpose**: Applications awaiting sponsorship to complete payment
- **Farm Status**: Farm not yet created (farmId is `null`)
- **Farm Name**: Deterministic star name generated from application ID (e.g., "Citrine Divide")
- **Zones**: Only zones with `isAcceptingSponsors: true`

### Mining-Center Fractions (`type=mining-center`)

- **Status**: `completed`
- **Purpose**: Completed applications selling mining rewards
- **Farm Status**: Farm already created (farmId exists)
- **Farm Name**: Actual farm name from database (e.g., "Gleaming Meadow")
- **Zones**: Can be in any zone

## Response Structure

Returns an array of application objects with the following structure:

```typescript
{
  id: string;                           // Application ID
  userId: string;                       // Owner wallet address
  status: string;                       // Application status
  createdAt: Date;                      // Application creation date

  // Farm Information
  farmId: string | null;                // Farm ID (null for launchpad)
  farmName: string | null;              // Farm name (see Fraction Types above)

  // Auction Information
  isPublishedOnAuction: boolean;        // Has active fraction
  publishedOnAuctionTimestamp: Date | null;
  sponsorSplitPercent: number | null;   // Current sponsor split %

  // Payment Information
  finalProtocolFee: string;             // Protocol fee amount
  paymentCurrency: string;              // Current payment currency
  paymentEventType: string;             // Payment event type

  // Related Data
  zone: {                               // Zone information
    id: number;
    name: string;
    isAcceptingSponsors: boolean;
    isActive: boolean;
    requirementSet: {
      id: string;
      name: string;
      code: string;
    };
  };

  applicationPriceQuotes: [...];        // Available price quotes
  enquiryFields: {...};                 // Application enquiry data
  auditFields: {...};                   // Application audit data
  afterInstallPictures: [...];          // Solar panel pictures

  // Active Fraction Details
  activeFraction: {
    id: string;                         // Fraction ID (bytes32)
    nonce: string;                      // Fraction nonce
    status: string;                     // "draft" | "committed"
    sponsorSplitPercent: number;        // Sponsor split percentage
    createdAt: Date;                    // Fraction creation date
    expirationAt: Date;                 // Fraction expiration date
    isCommittedOnChain: boolean;        // Committed to blockchain
    isFilled: boolean;                  // All steps sold
    totalSteps: number;                 // Total steps available
    splitsSold: number;                 // Steps sold so far
    stepPrice: string;                  // Price per step (deprecated)
    step: string;                       // Price per step in token decimals
    token: string;                      // Payment token address
    owner: string;                      // Fraction owner address
    txHash: string | null;              // Commitment transaction hash
    rewardScore: number;                // Reward score multiplier

    // Calculated Fields
    progressPercent: number;            // Percentage filled (0-100)
    remainingSteps: number;             // Steps remaining
    amountRaised: string;               // Total raised so far
    totalAmountNeeded: string;          // Total funding goal
  } | null;
}
```

## How Farm Names Work

The `farmName` field is populated using the `getFarmNamesByApplicationIds` helper function:

1. **For Launchpad Fractions** (waiting-for-payment):

   - Farm doesn't exist yet (`farmId` is `null`)
   - Returns a deterministic star name based on application ID
   - Example: "Citrine Divide", "Azure Nebula", "Crimson Peak"

2. **For Mining-Center Fractions** (completed):
   - Farm already exists (`farmId` is set)
   - Returns the actual farm name from the `farms` table
   - Example: "Gleaming Meadow", "Eon Delta"

The function does a left join with the farms table:

```typescript
// From getFarmNamesByApplicationIds
const resolvedName =
  row.farmName ?? // Use farm name if exists
  getDeterministicStarNameForApplicationId(row.applicationId); // Otherwise generate
```

## Filtering Logic

### Active Fraction Requirements

Only applications with active fractions are returned:

- Fraction status: `committed`
- `isCommittedOnChain: true`
- `expirationAt > now()`
- Fraction type matches query parameter (or excludes mining-center by default)

### Zone Requirements

- Zone must have `isAcceptingSponsors: true`
- For launchpad: application status is `waiting-for-payment`
- For mining-center: application status is `completed`

### Payment Currency Filtering

When `paymentCurrency` is specified, only returns applications that have a price quote for that currency with a value > 0.

## Example Requests

### Get all launchpad fractions

```bash
GET /applications/sponsor-listings-applications?type=launchpad
```

### Get mining-center fractions, sorted by sponsor split

```bash
GET /applications/sponsor-listings-applications?type=mining-center&sortBy=sponsorSplitPercent&sortOrder=desc
```

### Get applications in a specific zone that accept USDC

```bash
GET /applications/sponsor-listings-applications?zoneId=2&paymentCurrency=USDC&sortBy=paymentCurrency&sortOrder=asc
```

## Example Response

```json
[
  {
    "id": "a315a8e5-dcd7-4e2b-bdba-54a34e03e826",
    "userId": "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
    "status": "waiting-for-payment",
    "farmId": null,
    "farmName": "Citrine Divide",
    "sponsorSplitPercent": 50,
    "activeFraction": {
      "id": "0x2def3fbbc0ada0fe64085397e173a59c178cb78f16b8ba70584b95fb1a361c53",
      "totalSteps": 100,
      "splitsSold": 25,
      "progressPercent": 25,
      "remainingSteps": 75,
      "expirationAt": "2025-12-01T00:00:00.000Z"
    }
  }
]
```

## Implementation Notes

### Performance

- Farm names are batch-fetched after filtering to minimize database queries
- Sorting is done in JavaScript after the SQL query due to complexities with joins
- Results are filtered client-side when using `paymentCurrency` parameter

### Data Consistency

- The `farmName` field was added to provide a consistent way to display farm names
- For launchpad fractions, the name is deterministic and can be shown to users before farm creation
- For mining-center fractions, the name matches the actual created farm

### Related Endpoints

- `/fractions/available` - Get all available fractions
- `/fractions/splits-activity` - Get recent purchase activity
- `/applications/by-application-id` - Get application details
