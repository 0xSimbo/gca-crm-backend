# Lebanon Quotes Onboarding (API Key Auth)

This guide shows how to:

- Generate an API key for your org
- Submit **single** Lebanon quotes (fixed rate, no utility bill)
- Submit **batch** Lebanon quotes (fixed rate, no utility bills)
- Retrieve quotes created by your API key

Lebanon quotes use a fixed blended electricity rate of **0.3474 USD/kWh** (no AI extraction).

---

## 1) Generate an API key for your org

Create an org-scoped API key (returned **once**). Store it securely.

### curl

```bash
curl -sS -X POST "https://api.glowlabs.org/quotes/api-keys" \
  -H "content-type: application/json" \
  -d '{
    "orgName": "Acme Lebanon Solar",
    "email": "dev@acme.example"
  }'
```

### Response

```json
{
  "orgName": "Acme Lebanon Solar",
  "apiKey": "gq_..."
}
```

---

## 2) Retrieve all quotes created by your API key

This endpoint returns all quotes associated with your API key (using the admin-configured `quote_api_keys.wallet_address` if set; otherwise a pseudo-wallet derived from your apiKey hash).

### curl

```bash
curl -sS "https://api.glowlabs.org/quotes/project-quotes" \
  -H "x-api-key: gq_..."
```

### Response

```json
{
  "walletAddress": "0x...",
  "orgName": "Acme Lebanon Solar",
  "quotes": [
    {
      "id": "uuid",
      "regionCode": "LB",
      "electricityPricePerKwh": "0.3474",
      "priceSource": "blended",
      "utilityBillUrl": "lebanon-fixed-rate"
    }
  ]
}
```

Notes:

- Numeric DB fields often come back as **strings**.
- Filter Lebanon quotes by `regionCode === "LB"` if your org also creates non-Lebanon quotes.

---

## 3) Submit a single Lebanon quote (API key auth)

### Endpoint

- `POST /quotes/project/lebanon`

### Rate limit

- **500 Lebanon quotes per hour** (global), counted per quote.

### Request (JSON)

All numeric inputs are sent as **strings**.

```json
{
  "weeklyConsumptionMWh": "0.3798",
  "systemSizeKw": "0.01896",
  "latitude": "33.8938",
  "longitude": "35.5018",
  "metadata": "Beirut - Project 123",
  "isProjectCompleted": false
}
```

### curl

```bash
curl -sS -X POST "https://api.glowlabs.org/quotes/project/lebanon" \
  -H "content-type: application/json" \
  -H "x-api-key: gq_..." \
  -d '{
    "weeklyConsumptionMWh": "0.3798",
    "systemSizeKw": "0.01896",
    "latitude": "33.8938",
    "longitude": "35.5018",
    "metadata": "Beirut - Project 123",
    "isProjectCompleted": false
  }'
```

### Response (success)

You’ll receive a `quoteId` plus the computed metrics. The extraction block shows the fixed Lebanon rate.

```json
{
  "quoteId": "uuid",
  "regionCode": "LB",
  "extraction": {
    "electricityPricePerKwh": 0.3474,
    "confidence": 1,
    "utilityBillUrl": "lebanon-fixed-rate"
  }
}
```

---

## 4) Submit Lebanon quotes in batch (API key auth)

### Endpoint

- `POST /quotes/project/lebanon/batch`

### Rate limit

- **500 Lebanon quotes per hour** (global), counted per item.

### Request (JSON)

Send `requests` as an array (1–100 items). All numeric inputs are strings.

```json
{
  "requests": [
    {
      "weeklyConsumptionMWh": "0.3798",
      "systemSizeKw": "0.01896",
      "latitude": "33.8938",
      "longitude": "35.5018",
      "metadata": "Beirut - Project 123",
      "isProjectCompleted": false
    },
    {
      "weeklyConsumptionMWh": "0.5000",
      "systemSizeKw": "0.02500",
      "latitude": "34.4367",
      "longitude": "35.8497",
      "metadata": "Tripoli - Project 456",
      "isProjectCompleted": false
    }
  ]
}
```

### curl

```bash
curl -sS -X POST "https://api.glowlabs.org/quotes/project/lebanon/batch" \
  -H "content-type: application/json" \
  -H "x-api-key: gq_..." \
  -d '{
    "requests": [
      {
        "weeklyConsumptionMWh": "0.3798",
        "systemSizeKw": "0.01896",
        "latitude": "33.8938",
        "longitude": "35.5018",
        "metadata": "Beirut - Project 123",
        "isProjectCompleted": false
      },
      {
        "weeklyConsumptionMWh": "0.5000",
        "systemSizeKw": "0.02500",
        "latitude": "34.4367",
        "longitude": "35.8497",
        "metadata": "Tripoli - Project 456",
        "isProjectCompleted": false
      }
    ]
  }'
```

### Response

Returns per-item results (with `quoteId` on success). Use the quote IDs to correlate with your internal records.

```json
{
  "itemCount": 2,
  "successCount": 2,
  "errorCount": 0,
  "results": [
    { "index": 0, "success": true, "quoteId": "uuid-1" },
    { "index": 1, "success": true, "quoteId": "uuid-2" }
  ]
}
```

---

## 5) Common pitfalls

- **Use strings for numeric fields**: even in JSON (`"0.5000"` not `0.5`). This keeps formatting consistent across clients and avoids accidental precision/format changes.
- **Don’t send both** `x-api-key` **and** wallet `timestamp/signature` in the same request.
- **Max batch size is 100 items** per request.
