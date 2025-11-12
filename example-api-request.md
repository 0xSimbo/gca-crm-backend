# Non-Account Quote API Example

## Test Data (Independence, MO)
- **Address**: 2614 Ringo Rd, Independence, MO 64057, USA
- **Coordinates**: 39.0707091494141, -94.35609788750925
- **System Size**: 0.01896 kW (from planset)
- **Annual Consumption**: 19,751 kWh
- **Weekly Consumption**: 0.3798 MWh

## Region Code Derivation Test
✅ **Success**: Coordinates automatically mapped to `US-MO` (Missouri)

## API Request Example

### Before (Required regionCode)
```json
{
  "regionCode": "US-MO",
  "weeklyConsumptionMWh": "0.3798269230769231",
  "systemSizeKw": "0.01896",
  "latitude": "39.0707091494141",
  "longitude": "-94.35609788750925",
  "utilityBill": "[File object]"
}
```

### After (Automatic region derivation)
```json
{
  "weeklyConsumptionMWh": "0.3798269230769231",
  "systemSizeKw": "0.01896", 
  "latitude": "39.0707091494141",
  "longitude": "-94.35609788750925",
  "utilityBill": "[File object]"
}
```

## cURL Example
```bash
curl -X POST http://localhost:3000/applications/non-account/quote \
  -F "weeklyConsumptionMWh=0.3798269230769231" \
  -F "systemSizeKw=0.01896" \
  -F "latitude=39.0707091494141" \
  -F "longitude=-94.35609788750925" \
  -F "utilityBill=@/path/to/misc_utility_bill.pdf"
```

## API Response
The API will return:
- **Derived Region**: `US-MO` (automatically determined from coordinates)
- **Protocol Deposit**: Estimated USD amount (6 decimals)
- **Carbon Metrics**: Weekly credits, debt, and net carbon credits
- **Efficiency Score**: Based on deposit vs impact ratio
- **Extraction Details**: Electricity price from utility bill analysis

## Key Changes
1. ❌ **Removed**: `regionCode` field from request body
2. ✅ **Added**: Automatic region derivation from lat/lng coordinates  
3. ✅ **Improved**: Simplified API - users only provide location data once
4. ✅ **Enhanced**: Better error messages for unsupported regions
