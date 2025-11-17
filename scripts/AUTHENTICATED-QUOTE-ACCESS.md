# Authenticated Quote Access - User Dashboard

## Overview

Users who are logged in can access their project quotes through the applications API using their bearer token. Quotes are automatically linked to users when the wallet address used to create the quote matches their account ID.

## Prerequisites

- User must be logged in with a bearer token (JWT)
- Quote must have been created by a wallet address that matches the user's account ID
- **Special Access**: FOUNDATION_HUB_MANAGER wallet has access to ALL quotes

## API Endpoints

### 1. Get All Your Quotes

```
GET /applications/project-quotes
Authorization: Bearer <your_jwt_token>
```

**Behavior:**
- **Regular Users**: Returns only quotes where `userId` matches the authenticated user
- **FOUNDATION_HUB_MANAGER**: Returns ALL quotes from all users (admin access)

**Response:**

```json
{
  "quotes": [
    {
      "id": "uuid",
      "createdAt": "2025-11-14T14:17:10.000Z",
      "walletAddress": "0x5252fda14a149c01ea5a1d6514a9c1369e4c70b4",
      "userId": "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
      "regionCode": "US-MO",
      "latitude": "39.07071",
      "longitude": "-94.35610",
      "weeklyConsumptionMWh": "0.37983",
      "systemSizeKw": "0.01896",
      "electricityPricePerKwh": "0.10126",
      "protocolDepositUsd6": "38348280588",
      "weeklyCredits": "0.1368",
      "weeklyDebt": "0.0000",
      "netWeeklyCc": "0.1368",
      "netCcPerMwh": "0.3602",
      "efficiencyScore": 35.6729,
      ...
    }
  ]
}
```

### 2. Get Single Quote by ID

```
GET /applications/project-quote/:id
Authorization: Bearer <your_jwt_token>
```

**Example:**

```
GET /applications/project-quote/0b3da480-25c6-4f84-8f0d-3afd4a315b52
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Access Control:**
- **Regular Users**: Can only access quotes where `userId` matches their account
- **FOUNDATION_HUB_MANAGER**: Can access ANY quote by ID (admin access)
- **403 Forbidden**: Returned if regular user tries to access someone else's quote

**Response:**

```json
{
  "quoteId": "0b3da480-25c6-4f84-8f0d-3afd4a315b52",
  "createdAt": "2025-11-14T14:17:10.000Z",
  "walletAddress": "0x5252fda14a149c01ea5a1d6514a9c1369e4c70b4",
  "userId": "0x5252FdA14A149c01EA5A1D6514a9c1369E4C70b4",
  "regionCode": "US-MO",
  "location": {
    "latitude": 39.0707091494141,
    "longitude": -94.35609788750925
  },
  "inputs": {
    "weeklyConsumptionMWh": 0.3798269230769231,
    "systemSizeKw": 0.01896
  },
  "protocolDeposit": {
    "usd6Decimals": "38348280588",
    "usd": 38348.28
  },
  "carbonMetrics": {
    "weeklyCredits": 0.1368,
    "weeklyDebt": 0.0000,
    "netWeeklyCc": 0.1368,
    "netCcPerMwh": 0.3602,
    "carbonOffsetsPerMwh": 0.360207,
    "uncertaintyApplied": 0.1
  },
  "efficiency": {
    "score": 35.6729,
    "weeklyImpactAssetsWad": "136800000000000000"
  },
  "rates": {
    "discountRate": 0.07,
    "escalatorRate": 0.0331,
    "commitmentYears": 30
  },
  "extraction": {
    "electricityPricePerKwh": 0.1012,
    "confidence": 0.95,
    "source": "ai",
    "utilityBillUrl": "https://..."
  },
  "debug": { ... }
}
```
