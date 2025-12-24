# Project Quote API - Partner Integration Guide

## Overview

The Project Quote API allows partners to programmatically create solar project quotes using either wallet signature authentication (sign quote parameters with an Ethereum wallet) or API key authentication (send an `x-api-key` header).

Partners can add optional metadata to each quote (e.g., farm owner name, project ID) to make quotes easier to identify and manage in the dashboard.

## Authentication Method

### Wallet Signature

Sign a message containing your quote data with your Ethereum private key. The API verifies the signature and associates the quote with your wallet address.

### API Key (Optional)

If you don't want to manage wallet signatures, you can use an API key:

- Create a key: `POST /quotes/api-keys` with `{ orgName, email }`
- Use the key by sending it in the request header: `x-api-key: gq_...`
- The raw key is returned **only once** at creation time. Store it securely (like a password).

## API Endpoints

### 1. Get Available Regions

```
GET /quotes/regions
```

Returns all supported regions. Note: Region selection is automatic based on coordinates.

### 2a. Create API Key (Optional)

```
POST /quotes/api-keys
```

Create an org-scoped API key for Quote API access.

- The raw `apiKey` is returned **only once**. Store it securely.
- The server stores only a **sha256 hash** of the key (not the raw key).

**Request (JSON):**

- `orgName` (string): Organization name (unique)
- `email` (string): Contact email

**Response (201 Created):**

- `orgName`
- `apiKey`

### 2. Create Project Quote

```
POST /quotes/project
```

Create a new quote using **either** wallet signature auth **or** API key auth (`x-api-key` header).

**Required Fields:**

- `weeklyConsumptionMWh` (string): Weekly energy consumption in MWh
- `systemSizeKw` (string): Solar system size in kW
- `latitude` (string): Location latitude
- `longitude` (string): Location longitude
- `utilityBill` (File): PDF utility bill (max 10MB)

**Auth (pick one):**

- Wallet signature auth:
  - `timestamp` (number): Current Unix timestamp in milliseconds
  - `signature` (string): Wallet signature of the message
- API key auth:
  - Header `x-api-key: gq_...`

**Optional Fields:**

- `metadata` (string): Custom identifier for the quote (e.g., "John Smith - Farm #123", "Project ABC")
- `isProjectCompleted` (boolean): Flag indicating if the solar project is already live/completed (default: false)

**Message to Sign:**

```
{weeklyConsumptionMWh},{systemSizeKw},{latitude},{longitude},{timestamp}
```

Example: `0.3798,0.01896,39.0707,-94.3561,1699564800000`

### 3. Create Project Quotes (Batch, Async)

```
POST /quotes/project/batch
```

Create multiple quotes in a single request. This endpoint is **asynchronous** (it returns a `batchId` immediately).

**Rate limit (batch endpoint):**

- **100 applications per hour total**, counted **per item** in the batch (not per HTTP request).

**Request format:** `multipart/form-data`

- `requests` (string): JSON array of quote request objects (same shape as the single-quote endpoint, **without** `utilityBill`).
  - Wallet signature auth: each item includes `timestamp` + `signature`
  - API key auth: omit `timestamp` + `signature` and send header `x-api-key: gq_...`
- `utilityBills` (File[]): One PDF per request, **same order** as `requests`.

**Response format (202 Accepted):**

- Returns:
  - `batchId`
  - `etaSeconds` (rough estimate)
  - `statusEndpoint` (poll URL)

### 4. Get Batch Status / Results

```
GET /quotes/project/batch/{batchId}?timestamp={ts}&signature={sig}
```

Poll a previously submitted batch.

If the batch was created using API key auth, you can poll without a signature by sending header `x-api-key: gq_...` and calling:

```
GET /quotes/project/batch/{batchId}
```

**Message to sign:**

```
{batchId},{timestamp}
```

**Response:**

- `status`: `queued | running | completed | failed`
- Progress counters: `itemCount`, `processedCount`, `successCount`, `errorCount`
- When `completed` (or `failed`), includes `results` as an array of:
  - `{ index, success: true, quoteId }`
  - `{ index, success: false, error }`

### 5. Get Quotes by Wallet

```
GET /quotes/project/{walletAddress}
```

Retrieve all quotes created by a specific wallet address.

### 5b. Get Quotes for Current API Key

```
GET /quotes/project-quotes
x-api-key: gq_...
```

Retrieve all quotes associated with the provided API key (uses admin-configured `quote_api_keys.wallet_address` when set; otherwise uses the pseudo-wallet derived from the apiKey hash).

### 6. Get Quote by ID

```
GET /quotes/project/quote/{quoteId}?signature={sig}&timestamp={ts}
```

Retrieve a specific quote. Optional signature verification for access control.

## Authenticated Quote Management (Bearer Token)

Once logged into the dashboard with a bearer token, users can manage their quotes and view quote status. Hub managers have additional administrative capabilities.

### Quote Status Lifecycle

All quotes start with status `"pending"` and can transition to:

- `"approved"` - Owner accepted the quote
- `"rejected"` - Owner declined the quote
- `"cancelled"` - Owner or hub manager cancelled the quote

**Status Transition Rules:**

- Only `pending` quotes can be approved, rejected, or cancelled
- Once a quote has a final status, it cannot be changed

### 6. Get User's Quotes (Authenticated)

```
GET /applications/project-quotes
Authorization: Bearer {jwt-token}
```

Returns all quotes created by wallet addresses linked to the authenticated user account.

**Special Access:** `FOUNDATION_HUB_MANAGER` has access to ALL quotes from all users.

### 7. Get Quote Details (Authenticated)

```
GET /applications/project-quote/:id
Authorization: Bearer {jwt-token}
```

Returns full quote details including admin fields (status, cashAmountUsd).

**Response includes:**

```json
{
  "quoteId": "uuid",
  "admin": {
    "cashAmountUsd": "12345.67" | null,
    "status": "pending" | "approved" | "rejected" | "cancelled"
  },
  ...
}
```

**Access Control:**

- **Regular Users**: Can only access quotes where userId matches their account
- **FOUNDATION_HUB_MANAGER**: Can access ANY quote by ID

### 8. Set Cash Amount (Hub Manager Only)

```
POST /applications/project-quote/:id/cash-amount
Authorization: Bearer {jwt-token}
Content-Type: application/json

{
  "cashAmountUsd": "12345.67"
}
```

Allows `FOUNDATION_HUB_MANAGER` to set the validated cash amount for a project quote.

**Important:** The hub manager must set the cash amount before quote owners can approve or reject the quote.

**Response:**

```json
{
  "message": "Cash amount updated successfully",
  "quote": {
    "id": "uuid",
    "cashAmountUsd": "12345.67"
  }
}
```

### 9. Approve Quote (Owner Only)

```
POST /applications/project-quote/:id/approve
Authorization: Bearer {jwt-token}
```

Allows the quote owner to approve a pending quote.

**Requirements:**

- User must own the quote (userId matches)
- Quote must have status `"pending"`
- Hub manager must have set `cashAmountUsd` first

**Response:**

```json
{
  "message": "Quote approved successfully",
  "quoteId": "uuid",
  "status": "approved"
}
```

### 10. Reject Quote (Owner Only)

```
POST /applications/project-quote/:id/reject
Authorization: Bearer {jwt-token}
```

Allows the quote owner to reject a pending quote.

**Requirements:**

- User must own the quote (userId matches)
- Quote must have status `"pending"`
- Hub manager must have set `cashAmountUsd` first

**Response:**

```json
{
  "message": "Quote rejected successfully",
  "quoteId": "uuid",
  "status": "rejected"
}
```

### 11. Cancel Quote (Owner or Hub Manager)

```
POST /applications/project-quote/:id/cancel
Authorization: Bearer {jwt-token}
```

Allows the quote owner or `FOUNDATION_HUB_MANAGER` to cancel a pending quote.

**Requirements:**

- User must own the quote OR be hub manager
- Quote must have status `"pending"`

**Response:**

```json
{
  "message": "Quote cancelled successfully",
  "quoteId": "uuid",
  "status": "cancelled"
}
```

## Integration Example (TypeScript)

```typescript
import { Wallet } from "ethers";
import { readFileSync } from "fs";

// Initialize wallet from private key (store in .env!)
const wallet = new Wallet(process.env.PRIVATE_KEY);

// Prepare quote data
const quoteData = {
  weeklyConsumptionMWh: "0.3798",
  systemSizeKw: "0.01896",
  latitude: "39.0707",
  longitude: "-94.3561",
  timestamp: Date.now(),
};

// Create message to sign
const message = `${quoteData.weeklyConsumptionMWh},${quoteData.systemSizeKw},${quoteData.latitude},${quoteData.longitude},${quoteData.timestamp}`;

// Sign the message
const signature = await wallet.signMessage(message);

// Prepare form data
const formData = new FormData();
formData.append("weeklyConsumptionMWh", quoteData.weeklyConsumptionMWh);
formData.append("systemSizeKw", quoteData.systemSizeKw);
formData.append("latitude", quoteData.latitude);
formData.append("longitude", quoteData.longitude);
formData.append("timestamp", quoteData.timestamp.toString());
formData.append("signature", signature);

// Optional: Add metadata to help identify the quote
formData.append("metadata", "John Smith - Farm #123");

// Optional: Indicate if the project is already live/completed
formData.append("isProjectCompleted", "true");

// Load and append PDF
const pdfBuffer = readFileSync("./utility_bill.pdf");
const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" });
const pdfFile = new File([pdfBlob], "utility_bill.pdf", {
  type: "application/pdf",
});
formData.append("utilityBill", pdfFile);

// Send request
const response = await fetch("https://api.glowlabs.org/quotes/project", {
  method: "POST",
  body: formData,
});

const result = await response.json();

if (response.ok) {
  console.log("Quote ID:", result.quoteId);
  console.log("Protocol Deposit (USD):", result.protocolDeposit.usd);
  console.log("Region:", result.regionCode);
  console.log("Wallet:", result.walletAddress);
} else {
  console.error("Error:", result.error);
}
```

## API Key Integration Example (TypeScript)

Create an API key once (store it securely; it is returned only once):

```typescript
const createKeyResp = await fetch("https://api.glowlabs.org/quotes/api-keys", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    orgName: "Acme Solar",
    email: "dev@acme.example",
  }),
});

const { apiKey } = await createKeyResp.json();
```

Then call the same endpoints using the `x-api-key` header (omit `timestamp` + `signature`):

```typescript
const apiKey = process.env.GLOW_QUOTES_API_KEY;

const response = await fetch("https://api.glowlabs.org/quotes/project", {
  method: "POST",
  headers: { "x-api-key": apiKey },
  body: formData, // includes utilityBill, but NOT timestamp/signature
});
```

## Batch Integration Example (TypeScript)

```typescript
import { Wallet } from "ethers";
import { readFileSync } from "fs";

const wallet = new Wallet(process.env.PRIVATE_KEY);

const items = [
  {
    weeklyConsumptionMWh: "0.3798",
    systemSizeKw: "0.01896",
    latitude: "39.0707",
    longitude: "-94.3561",
  },
  {
    weeklyConsumptionMWh: "0.5000",
    systemSizeKw: "0.02500",
    latitude: "37.7749",
    longitude: "-122.4194",
  },
];

const requests = await Promise.all(
  items.map(async (item) => {
    const timestamp = Date.now().toString();
    const message = `${item.weeklyConsumptionMWh},${item.systemSizeKw},${item.latitude},${item.longitude},${timestamp}`;
    const signature = await wallet.signMessage(message);

    return {
      ...item,
      timestamp,
      signature,
      metadata: "Batch import",
      isProjectCompleted: false,
    };
  })
);

const formData = new FormData();
formData.append("requests", JSON.stringify(requests));

// IMPORTANT: Append one PDF per request, in the SAME ORDER as `requests`
const pdfBuffers = [
  readFileSync("./utility_bill_1.pdf"),
  readFileSync("./utility_bill_2.pdf"),
];

for (let i = 0; i < pdfBuffers.length; i++) {
  const pdfBlob = new Blob([pdfBuffers[i]], { type: "application/pdf" });
  const pdfFile = new File([pdfBlob], `utility_bill_${i + 1}.pdf`, {
    type: "application/pdf",
  });

  // Repeated field name => server receives an array
  formData.append("utilityBills", pdfFile);
}

const response = await fetch("https://api.glowlabs.org/quotes/project/batch", {
  method: "POST",
  body: formData,
});

const result = await response.json();
console.log(result);

// Poll status (async)
const batchId = result.batchId as string;
const pollTimestamp = Date.now().toString();
const pollMessage = `${batchId},${pollTimestamp}`;
const pollSignature = await wallet.signMessage(pollMessage);

const statusResp = await fetch(
  `https://api.glowlabs.org/quotes/project/batch/${batchId}?timestamp=${pollTimestamp}&signature=${pollSignature}`
);
const status = await statusResp.json();
console.log(status);
```

## Note on Gemini / Vertex “Batch Mode”

Google also offers an **asynchronous** “Batch Mode” API for Gemini where you upload a JSONL file and create a long-running batch job (up to hours). This is great for offline workloads, but it’s **not used** by `/quotes/project/batch` because this quote API is designed to return results immediately. See:

- [Gemini API Batch Mode docs](https://ai.google.dev/gemini-api/docs/batch-mode)
- [Batch Mode announcement](https://developers.googleblog.com/en/scale-your-ai-workloads-batch-mode-gemini-api/)

## Response Format

```json
{
  "quoteId": "uuid-string",
  "walletAddress": "0x...",
  "userId": "0x..." | null,
  "metadata": "John Smith - Farm #123",
  "isProjectCompleted": false,
  "regionCode": "US-MO",
  "protocolDeposit": {
    "usd": 12345.67,
    "usd6Decimals": "12345670000"
  },
  "carbonMetrics": {
    "weeklyCredits": 1.2345,
    "weeklyDebt": 0.1234,
    "netWeeklyCc": 1.1111,
    "netCcPerMwh": 2.9234,
    "carbonOffsetsPerMwh": 0.456789,
    "uncertaintyApplied": 0.1
  },
  "efficiency": {
    "score": 0.0234,
    "weeklyImpactAssetsWad": "1234567890123456789"
  },
  "rates": {
    "discountRate": 0.07,
    "escalatorRate": 0.0331,
    "commitmentYears": 30
  },
  "extraction": {
    "electricityPricePerKwh": 0.10125,
    "confidence": 0.95,
    "rationale": "Base rate: $133.05/1314 kWh = $0.10125/kWh...",
    "utilityBillUrl": "https://..."
  },
  "debug": { ... }
}
```

## Security Notes

1. **Private Key Security**: Never commit private keys. Always use environment variables.
2. **Timestamp Validation**: Signatures expire after 5 minutes to prevent replay attacks.
3. **Wallet Association**: If your wallet address matches a user in our system, quotes are automatically linked to your account.
4. **Quote Access**: Only the wallet that created a quote can access it (unless linked to a user).

## Error Handling

- **400**: Invalid input data, expired timestamp, unsupported region, or invalid status transition
- **401**: Invalid signature or expired/missing bearer token
- **403**: Access denied (wallet doesn't own the quote or insufficient permissions)
- **404**: Quote not found
- **429**: Rate limit exceeded (100 quotes per hour system-wide)
- **500**: Internal server error

### Common Error Responses

**Invalid Status Transition:**

```json
{
  "error": "Cannot approve quote with status 'approved'. Only pending quotes can be approved."
}
```

**Missing Cash Amount:**

```json
{
  "error": "Cannot approve quote. Hub manager must set cash amount first."
}
```

**Insufficient Permissions:**

```json
{
  "error": "Access denied. Only hub manager can set cash amount."
}
```

**Quote Not Found:**

```json
{
  "error": "Quote not found"
}
```

## Testing

Run the test script:

```bash
# Add your private key to .env
echo "TEST_WALLET_PRIVATE_KEY=0x..." >> .env

# Run the test
bun run scripts/test-quote-api-with-wallet.ts
```

## Support

For questions or issues, contact: julien@glow.org
