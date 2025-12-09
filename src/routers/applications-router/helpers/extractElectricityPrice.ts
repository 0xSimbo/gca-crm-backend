import { GoogleGenerativeAI } from "@google/generative-ai";
import { uploadFile } from "../../../utils/r2/upload-to-r2";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export interface ElectricityPriceExtractionResult {
  pricePerKwh: number;
  pricePerKwhLocal: number;
  currencyCode: string;
  confidence: number;
  rationale: string;
}

const BASE_PROMPT = `IMPORTANT: NEVER REJECT A BILL. Always extract the electricity price.

If the bill shows solar generation (e.g., "Energy Charge Generated", "Solar Credit", "Generated kWh"):
- DO NOT REJECT - instead, calculate the BASE electricity rate
- Use ONLY the POSITIVE consumption charges (ignore credits/generation)
- The goal is to find what the customer PAYS per kWh for electricity they CONSUME

NORMAL utility bill items (NOT reasons to reject):
- "Lighting Service" or "Outdoor Lighting"
- "Current Electric Service - Residential"
- Multiple service categories on one bill
- "Renewable Energy Adjustment"
- Budget billing or levelized billing
- Income-based discounts or credits
- "Generated" or solar credits - just ignore these when calculating the consumption rate

---

PRICE EXTRACTION METHODOLOGY:

CRITICAL: Use the TOTAL BILL METHOD.

STEP 1: Start with total electric charges
- For multi-utility bills: Find "Electric Total" or electric section subtotal
- For electric-only bills: Use "Total New Charges" or "Amount Due"

STEP 2: INCLUDE (Keep) - Usage-based charges that scale with kWh:
✅ Energy Charges (base rate per kWh, tiered rates)
✅ Transmission & Distribution Service
✅ Fuel Adjustment / Surcharges / FPPAS
✅ Environmental fees (if per kWh)
✅ Power factor incentives/penalties (if usage-based)
✅ City/Municipal/State Taxes (if % of total bill)

STEP 3: EXCLUDE (Subtract) - Fixed charges and credits NOT affected by solar:
❌ Basic Charge / Customer Charge / Service Charge (flat monthly fees)
❌ Meter Fees / Rent
❌ Demand Charges (based on peak kW/kVA, not kWh)
❌ Electricity Duty (ED) or WCC (Specific to India, often excluded in net-metering analysis)
❌ Previous Balance / Arrears
❌ Solar generation credits

STEP 4: Calculate
  (Electric Total - Fixed Charges) ÷ Total kWh = Price per kWh

INTERNATIONAL BILLS (Non-USD):
1. Calculate the price per kWh in the LOCAL currency first.
2. Return the ISO currency code (e.g., INR).
3. DO NOT convert to USD yourself in the reasoning.`;

const US_PROMPT = `US-SPECIFIC GUIDANCE:
- Income-based discounts are fixed credits. NEVER subtract them.
- Ignore "Energy Charge Generated" credits.
- Include taxes and municipal fees if they are a % of energy charges.`;

const INDIA_PROMPT = `INDIA-SPECIFIC GUIDANCE (Rajasthan / JVVNL style bills):

⚠️ CRITICAL WARNING FOR JVVNL BILLS:
1. kWh SELECTION:
   - You MUST use "Net KWH Cons. To Bill at LIP rate" or "Consumption (5 x 6)=7".
   - Value usually appears in the "(A) METER READING" table under "Consumption".
   - ⛔️ NEVER use the "Billed Consumption in Last Twelve Billing Months" table at the bottom of the page.
   - ⛔️ NEVER use "Billing Demand" or "Contract Demand".
   - If the main page shows "Net KWH Cons. To Bill at LIP rate: 113790.00", USE 113790.

2. "Detailed Energy Cost Calculation" TABLE:
   - Check if the PDF contains a table titled "Detailed Energy Cost Calculation".
   - If found, transcribe the "Fee amount" column exactly into the JSON output.
   - Use "Total Fees" / "Total kWh usage" from THIS table if available.

3. FALLBACK CALCULATION (If detailed table is missing):
   - Energy Charges: Include "Energy Charges (1)"
   - Fuel Surcharges: Include "Regular Fuel Amt", "Base FPPAS", "Special Fuel Amt".
   - Surcharges: Include "TOD Surcharge".
   - Rebates: Include "TOD Rebate", "Power Factor Inct".

   ⚠️ MATH RULE FOR REBATES / INCENTIVES:
   - "TOD Rebate" and "PF Incentive" are SAVINGS. They REDUCE the bill.
   - Regardless of whether they are written as negative numbers (e.g. -25053) or positive numbers in a credit column, you must SUBTRACT their absolute value from the Total.
   - DO NOT ADD THEM.
   - Example: Energy (100) + Surcharge (10) - Rebate (5) = 105. NOT 115.

   ⛔️ EXCLUDE: "Fixed Charges", "Electricity Duty (ED)", "WCC", "Water Cess", "Urban Cess", "TCS".
   ⛔️ EXCLUDE: "Demand Charges" or "Minimum Charges".

   Formula: (Energy Charges + Fuel Surcharges + TOD Surcharge - |TOD Rebate| - |PF Incentive|) / Net KWH Cons`;

const OTHER_REGION_PROMPT = `NON-US/INDIA GUIDANCE:
- Follow the base methodology strictly.
- Clearly state the local currency.`;

function buildPromptForRegion(regionCode?: string | null) {
  const segments = [BASE_PROMPT];
  const normalized = regionCode?.toUpperCase() ?? null;
  const countryCode = normalized?.split("-")[0] ?? null;

  if (countryCode === "US") {
    segments.push(US_PROMPT);
  } else if (countryCode === "IN") {
    segments.push(INDIA_PROMPT);
  } else {
    segments.push(OTHER_REGION_PROMPT);
  }

  return segments.join("\n\n");
}

async function convertToUsd(amount: number, currencyCode: string) {
  const upperCode = currencyCode.toUpperCase();
  if (upperCode === "USD") {
    return amount;
  }

  const params = new URLSearchParams({
    amount: amount.toString(),
    from: upperCode,
    to: "USD",
  });

  const response = await fetch(
    `https://api.frankfurter.app/latest?${params.toString()}`
  );
  if (!response.ok) {
    throw new Error(
      `Frankfurter API failed (${response.status}): ${response.statusText}`
    );
  }

  const data = (await response.json()) as {
    rates?: Record<string, number>;
  };
  const usdValue = data.rates?.USD;
  if (typeof usdValue !== "number") {
    throw new Error("Frankfurter API returned no USD rate");
  }

  return usdValue;
}

export async function extractElectricityPriceFromUtilityBill(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
  regionCode?: string | null
): Promise<{ result: ElectricityPriceExtractionResult; billUrl: string }> {
  const bucketName = process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("R2_NOT_ENCRYPTED_FILES_BUCKET_NAME not configured");
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  if (contentType !== "application/pdf") {
    throw new Error(
      "Only PDF utility bills are accepted. Please upload a PDF file."
    );
  }

  // Upload to R2
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `utility-bills/${timestamp}-${sanitizedFileName}`;
  const billUrl = await uploadFile(bucketName, key, fileBuffer, contentType);

  // Use Gemini-2.5-flash
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  const base64Pdf = fileBuffer.toString("base64");

  const prompt = `${buildPromptForRegion(regionCode)}

Output ONLY valid JSON:
{
  "currencyCode": "<ISO 4217, e.g., USD, INR>",
  "pricePerKwhLocal": <number in local currency>,
  "pricePerKwh": <same as local if USD>,
  "confidence": <number 0-1, e.g., 0.95>,
  "rationale": "<show your calculation step by step>",
  "indiaChargesAndFees": {
    "found": <boolean, true if the Detailed Energy Cost Calculation table was found>,
    "totalKwhUsage": <number used in calculation>,
    "rows": [
      {"label": "Row Label", "amount": <number>}
    ]
  }
}
`;

  // Retry logic
  let result;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Pdf,
          },
        },
      ]);
      break;
    } catch (error) {
      lastError = error as Error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  if (!result) {
    throw new Error(
      `Gemini API failed after 3 attempts: ${lastError?.message}`
    );
  }

  const responseText = result.response.text();

  let extractedData: ElectricityPriceExtractionResult;
  try {
    let cleanedResponse = responseText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "");

    const parsedJson = JSON.parse(cleanedResponse);

    let currencyCode = "USD";
    if (parsedJson.currencyCode?.length === 3) {
      currencyCode = parsedJson.currencyCode.toUpperCase();
    }

    let pricePerKwhLocal =
      parsedJson.pricePerKwhLocal || parsedJson.pricePerKwh;

    // Sanity check for India: If INR price is < 1.0, they likely converted to USD prematurely
    if (currencyCode === "INR" && pricePerKwhLocal < 2.0) {
      // It's likely extremely low, or they returned USD in the local field
      if (parsedJson.rationale.includes("$")) {
        currencyCode = "USD"; // Correction
      }
    }

    if (!pricePerKwhLocal) {
      throw new Error("No price found in JSON response");
    }

    let pricePerKwhUsd = pricePerKwhLocal;
    if (currencyCode !== "USD") {
      pricePerKwhUsd = await convertToUsd(pricePerKwhLocal, currencyCode);
    }

    extractedData = {
      pricePerKwh: pricePerKwhUsd,
      pricePerKwhLocal,
      currencyCode,
      confidence: parsedJson.confidence || 0.8,
      rationale: parsedJson.rationale || "Extracted from AI analysis",
    };
  } catch (parseError) {
    console.error("Failed to parse Gemini response:", responseText);
    throw new Error(`Failed to parse electricity price: ${parseError}`);
  }

  // Validation
  if (extractedData.pricePerKwh < 0.005 || extractedData.pricePerKwh > 2.0) {
    throw new Error(
      `Extracted price ${extractedData.pricePerKwh} USD/kWh seems unreasonable. Rationale: ${extractedData.rationale}`
    );
  }

  return { result: extractedData, billUrl };
}
