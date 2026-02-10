# Project Quote Creation (Bearer Auth)

## Overview

This endpoint allows authenticated hub frontend users to create project quotes using bearer token authentication. It mirrors the public `/quotes/project` endpoint but uses JWT authentication instead of wallet signatures.

## Endpoint

```
POST /applications/project-quote
```

**Authentication:** Bearer token (JWT) required

## Request Format

### Headers

```
Authorization: Bearer <your-jwt-token>
Content-Type: multipart/form-data
```

### Body Parameters

| Field                  | Type   | Required | Description                                                                     |
| ---------------------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `annualConsumptionMWh` | string | Yes      | Annual energy consumption in MWh (from Aurora)                                  |
| `systemSizeKw`         | string | Yes      | System size in kW (nameplate capacity)                                          |
| `latitude`             | string | Yes      | Latitude of the solar farm location                                             |
| `longitude`            | string | Yes      | Longitude of the solar farm location                                            |
| `utilityBill`          | File   | Yes      | Utility bill PDF for price extraction (max 10MB)                                |
| `metadata`             | string | No       | Optional metadata for identifying the quote (e.g., farm owner name, project ID) |

### Constraints

- `annualConsumptionMWh`: Must be a positive number
- `systemSizeKw`: Must be a positive number
- `latitude`: Valid latitude (-90 to 90)
- `longitude`: Valid longitude (-180 to 180)
- `utilityBill`: Must be a PDF file, maximum 10MB
- **Rate Limit**: 100 quotes per hour globally (all users combined)

## Response Format

### Success Response (200 OK)

```json
{
  "quoteId": "uuid-string",
  "walletAddress": "0x...",
  "userId": "0x...",
  "metadata": "optional-metadata",
  "regionCode": "REGION_CODE",
  "protocolDeposit": {
    "usd": 1234.56,
    "usd6Decimals": "1234560000"
  },
  "carbonMetrics": {
    "weeklyCredits": 10.5,
    "weeklyDebt": 2.3,
    "netWeeklyCc": 8.2,
    "netCcPerMwh": 4.1,
    "carbonOffsetsPerMwh": 0.5,
    "uncertaintyApplied": 0.15
  },
  "efficiency": {
    "score": "high",
    "weeklyImpactAssetsWad": "8200000000000000000"
  },
  "rates": {
    "discountRate": 0.05,
    "escalatorRate": 0.02,
    "commitmentYears": 10
  },
  "extraction": {
    "electricityPricePerKwh": 0.12,
    "confidence": 0.95,
    "rationale": "Extracted from utility bill section 3",
    "utilityBillUrl": "https://..."
  },
  "debug": {
    // Debug information for development
  }
}
```

### Error Responses

#### 400 Bad Request

```json
{
  "error": "annualConsumptionMWh must be a positive number"
}
```

Common validation errors:

- Invalid or negative `annualConsumptionMWh`
- Invalid or negative `systemSizeKw`
- Invalid coordinates
- Unsupported region (coordinates outside supported areas)
- Missing or invalid utility bill file
- File type not PDF
- File size exceeds 10MB

#### 401 Unauthorized

```json
{
  "error": "Invalid or missing bearer token"
}
```

#### 429 Too Many Requests

```json
{
  "error": "Rate limit exceeded. The system can process a maximum of 100 quotes per hour. Please try again later."
}
```

#### 500 Internal Server Error

```json
{
  "error": "Internal server error"
}
```

## Framework-Agnostic Implementation Examples

### JavaScript (Fetch API)

```javascript
async function createProjectQuote(authToken, quoteData) {
  const formData = new FormData();
  formData.append("annualConsumptionMWh", quoteData.annualConsumptionMWh);
  formData.append("systemSizeKw", quoteData.systemSizeKw);
  formData.append("latitude", quoteData.latitude);
  formData.append("longitude", quoteData.longitude);
  formData.append("utilityBill", quoteData.utilityBillFile);

  if (quoteData.metadata) {
    formData.append("metadata", quoteData.metadata);
  }

  const response = await fetch(
    "https://your-api.com/applications/project-quote",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create quote");
  }

  return await response.json();
}

// Usage
try {
  const quote = await createProjectQuote("your-jwt-token", {
    annualConsumptionMWh: "271.336",
    systemSizeKw: "100",
    latitude: "37.7749",
    longitude: "-122.4194",
    utilityBillFile: pdfFile, // File object from input
    metadata: "John Doe Farm Project",
  });

  console.log("Quote created:", quote.quoteId);
  console.log("Protocol deposit:", quote.protocolDeposit.usd, "USD");
} catch (error) {
  console.error("Error:", error.message);
}
```

### Python (Requests)

```python
import requests

def create_project_quote(auth_token, quote_data):
    url = 'https://your-api.com/applications/project-quote'

    headers = {
        'Authorization': f'Bearer {auth_token}'
    }

    files = {
        'utilityBill': ('bill.pdf', quote_data['utility_bill_file'], 'application/pdf')
    }

    data = {
        'annualConsumptionMWh': quote_data['annual_consumption_mwh'],
        'systemSizeKw': quote_data['system_size_kw'],
        'latitude': quote_data['latitude'],
        'longitude': quote_data['longitude']
    }

    if 'metadata' in quote_data:
        data['metadata'] = quote_data['metadata']

    response = requests.post(url, headers=headers, files=files, data=data)
    response.raise_for_status()

    return response.json()

# Usage
try:
    with open('utility_bill.pdf', 'rb') as bill_file:
        quote = create_project_quote('your-jwt-token', {
            'annual_consumption_mwh': '271.336',
            'system_size_kw': '100',
            'latitude': '37.7749',
            'longitude': '-122.4194',
            'utility_bill_file': bill_file,
            'metadata': 'John Doe Farm Project'
        })

    print(f"Quote created: {quote['quoteId']}")
    print(f"Protocol deposit: ${quote['protocolDeposit']['usd']}")
except requests.exceptions.HTTPError as e:
    print(f"Error: {e.response.json()['error']}")
```

### cURL

```bash
curl -X POST https://your-api.com/applications/project-quote \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "annualConsumptionMWh=271.336" \
  -F "systemSizeKw=100" \
  -F "latitude=37.7749" \
  -F "longitude=-122.4194" \
  -F "utilityBill=@/path/to/utility_bill.pdf" \
  -F "metadata=John Doe Farm Project"
```

## Key Differences from `/quotes/project`

| Feature            | `/quotes/project` (Public) | `/applications/project-quote` (Bearer) |
| ------------------ | -------------------------- | -------------------------------------- |
| Authentication     | Wallet signature           | Bearer token (JWT)                     |
| Wallet Address     | Recovered from signature   | Derived from authenticated userId      |
| Timestamp Required | Yes                        | No                                     |
| Signature Required | Yes                        | No                                     |
| Mock Overrides     | Available in staging       | Not available                          |
| Intended Use       | External API consumers     | Hub frontend only                      |

## Notes

### Lebanon auto-detection

If `latitude`/`longitude` fall within Lebanon, the server will automatically create a Lebanon fixed-rate quote (region `"LB"`):

- Electricity price is fixed at **0.3474 USD/kWh**
- Discount rate is fixed at **35%**
- The uploaded utility bill is **accepted but ignored** (kept required for compatibility with existing hub UI)

- The `walletAddress` in the response is automatically derived from the authenticated user's `userId`
- Region is automatically detected from the provided coordinates
- The utility bill PDF is processed using AI to extract the electricity price
- All quotes are persisted to the database
- The response format is identical to `/quotes/project` for frontend compatibility

## Error Handling Best Practices

1. **Validate inputs client-side** before making the request to provide better UX
2. **Handle rate limiting** by implementing exponential backoff
3. **Show detailed error messages** from the `error` field in the response
4. **Check file size** before upload to avoid unnecessary requests
5. **Verify PDF format** client-side before submission
6. **Implement loading states** as the endpoint may take several seconds due to PDF processing
