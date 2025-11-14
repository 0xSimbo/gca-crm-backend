# Project Quote API - Partner Integration Guide

## Overview
The Project Quote API allows partners to programmatically create solar project quotes using wallet signature authentication. No bearer tokens or user login required - just sign requests with your Ethereum wallet.

## Authentication Method
**Wallet Signature**: Sign a message containing your quote data with your Ethereum private key. The API verifies the signature and associates the quote with your wallet address.

## API Endpoints

### 1. Get Available Regions
```
GET /quotes/regions
```
Returns all supported regions. Note: Region selection is automatic based on coordinates.

### 2. Create Project Quote
```
POST /quotes/project
```
Create a new quote with wallet signature authentication.

**Required Fields:**
- `weeklyConsumptionMWh` (string): Weekly energy consumption in MWh
- `systemSizeKw` (string): Solar system size in kW
- `latitude` (string): Location latitude
- `longitude` (string): Location longitude
- `timestamp` (number): Current Unix timestamp in milliseconds
- `signature` (string): Wallet signature of the message
- `utilityBill` (File): PDF utility bill (max 10MB)

**Message to Sign:**
```
{weeklyConsumptionMWh},{systemSizeKw},{latitude},{longitude},{timestamp}
```

Example: `0.3798,0.01896,39.0707,-94.3561,1699564800000`

### 3. Get Quotes by Wallet
```
GET /quotes/project/{walletAddress}
```
Retrieve all quotes created by a specific wallet address.

### 4. Get Quote by ID
```
GET /quotes/project/quote/{quoteId}?signature={sig}&timestamp={ts}
```
Retrieve a specific quote. Optional signature verification for access control.

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

## Response Format

```json
{
  "quoteId": "uuid-string",
  "walletAddress": "0x...",
  "userId": "0x..." | null,
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

- **401**: Invalid signature
- **400**: Invalid input data, expired timestamp, or unsupported region
- **403**: Access denied (wallet doesn't own the quote)
- **404**: Quote not found
- **500**: Internal server error

## Testing

Run the test script:
```bash
# Add your private key to .env
echo "TEST_WALLET_PRIVATE_KEY=0x..." >> .env

# Run the test
bun run scripts/test-quote-api-with-wallet.ts
```

## Support

For questions or issues, contact: api-support@glowlabs.org
