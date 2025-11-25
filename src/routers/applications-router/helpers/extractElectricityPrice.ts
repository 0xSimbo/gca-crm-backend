import { GoogleGenerativeAI } from "@google/generative-ai";
import { uploadFile } from "../../../utils/r2/upload-to-r2";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export interface ElectricityPriceExtractionResult {
  pricePerKwh: number;
  confidence: number;
  rationale: string;
}

/**
 * Extracts electricity price from a utility bill PDF using Gemini API.
 * Uploads the bill to R2 and returns the URL along with extracted price.
 *
 * ONLY accepts PDF files.
 */
export async function extractElectricityPriceFromUtilityBill(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string
): Promise<{ result: ElectricityPriceExtractionResult; billUrl: string }> {
  const bucketName = process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("R2_NOT_ENCRYPTED_FILES_BUCKET_NAME not configured");
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  // Only accept PDFs
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

  // Extract price using Gemini API with PDF
  // Using gemini-2.5-flash for better accuracy with complex billing rules
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE",
      },
    ],
  } as any);

  const base64Pdf = fileBuffer.toString("base64");

  const prompt = `IMPORTANT: NEVER REJECT A BILL. Always extract the electricity price.

If the bill shows solar generation (e.g., "Energy Charge Generated", "Solar Credit", "Generated kWh"):
- DO NOT REJECT - instead, calculate the BASE electricity rate
- Use ONLY the POSITIVE consumption charges (ignore credits/generation)
- The goal is to find what the customer PAYS per kWh for electricity they CONSUME

NORMAL utility bill items (NOT reasons to reject):
- "Lighting Service" or "Outdoor Lighting" - street/yard light service
- "Current Electric Service - Residential" - standard residential electricity
- Multiple service categories on one bill
- "Renewable Energy Adjustment" - utility rate adjustment
- Budget billing or levelized billing
- Income-based discounts or credits
- "Generated" or solar credits - just ignore these when calculating the consumption rate

---

PRICE EXTRACTION METHODOLOGY (only if bill passed rejection check above):

CRITICAL: Use the TOTAL BILL METHOD - this is the most accurate way to capture all costs.

PRIMARY METHOD - Calculate Electric Cost per kWh:

GUIDING PRINCIPLE: Only include charges that will be affected by the addition of solar.
This means ONLY usage-based charges that scale with kWh consumption.

STEP 1: Start with total electric charges
- For multi-utility bills: Find "Electric Total" or electric section subtotal
- For electric-only bills: Use "Total New Charges" or "Amount Due"

STEP 2: INCLUDE (Keep) - Usage-based charges that scale with kWh:
✅ Energy Charges (base rate per kWh, tiered rates)
✅ Transmission Service (scales with kWh usage)
✅ Distribution Service (scales with kWh usage)
✅ Time-of-Use (TOU) rates
✅ Fuel Adjustment or Surcharges (if tied to usage)
✅ Environmental fees (if per kWh)
✅ Power factor incentives/penalties (if usage-based)
✅ City/Municipal Sales Taxes (if % of total bill)
✅ State Taxes (if % of total bill)
✅ Renewable Energy Adjustment (usage-based rate adjustment)
✅ Energy Balancing Account (usage-based adjustment)
✅ Customer Efficiency Services (if usage-based)

STEP 3: EXCLUDE (Subtract) - Fixed charges and credits NOT affected by solar:
❌ Basic Charge / Customer Charge / Service Charge (flat monthly fee - typically $10-15)
❌ Meter Fees (fixed)
❌ Demand Charges (based on peak kW, not kWh)
❌ Administrative or Regulatory Charges (fixed)
❌ Assistance program credits (e.g., "Home Electric Lifeline Program")
❌ Non-electric utilities (Water, Sewer, Storm water, Garbage, etc.)
❌ Previous Balance / Previous Charges / Amount Due At Last Billing (NOT current usage)
❌ Income-based discounts (e.g., "Income Qualified Discount", "Low Income Discount", "LIHEAP")
❌ Solar generation credits (e.g., "Energy Charge Generated", "Solar Export Credit")
❌ Any line items with "Generated" and a credit (CR) amount

IMPORTANT: Only use CURRENT period charges. Ignore "Previous Balance", "Previous Charges", or "Amount Due At Last Billing".

STEP 4: Calculate
  (Electric Total - Fixed Charges - Non-electric utilities) ÷ Total kWh = Price per kWh

Example (Ben's bill):
  Total New Charges: $161.68
  - Basic Charge: $10.00 (fixed fee - exclude)
  - Home Electric Lifeline: $0.16 (assistance - exclude)
  = $151.52 (usage-based electric costs)
  ÷ Total kWh: 1,146
  = $0.1322/kWh

Example (Shawna's multi-utility bill):
  Electric Total: $147.92 (already separated from water/sewer)
  - No fixed charges to subtract (if already excluded)
  ÷ Total kWh: 1,314
  = $0.1126/kWh

Example (bill with income-based discounts - Good Power):
  The bill shows these line items:
  - Current Service: $69.29 ← INCLUDE (base energy charge)
  - Income Qualified Discount: -$24.00 ← DO NOT SUBTRACT (income-based, not usage-based)
  - Income Qualified Fuel Discount: -$9.50 ← DO NOT SUBTRACT (income-based, not usage-based)
  - Environmental Compliance Cost: $6.61 ← INCLUDE
  - Municipal Franchise Fee: $0.51 ← INCLUDE
  - Sales Tax: $3.01 ← INCLUDE
  - Total Current Electric Service: $45.92 ← DO NOT USE THIS (it includes the income discounts)
  
  CORRECT CALCULATION:
  $69.29 + $6.61 + $0.51 + $3.01 = $79.42 (sum of usage-based charges only)
  $79.42 ÷ 437 kWh = $0.1817/kWh
  
  WHY: Income-based discounts are fixed credits based on household income qualification.
  They do NOT change based on kWh usage. If customer uses less electricity, they still get
  the same $24 discount. So these discounts should NOT reduce the per-kWh rate.

Example (bill WITH solar generation):
  Electric - Energy Charge: $152.00 ← INCLUDE (consumption)
  Electric - Energy Charge Generated: $152.00CR ← EXCLUDE (solar credit)
  Energy Use Tax: $8.58 ← INCLUDE
  Sales Tax: $6.29 ← INCLUDE
  Electric - Customer Charge: $10.00 ← EXCLUDE (fixed)
  
  Consumption charges: $152.00 + $8.58 + $6.29 = $166.87
  Total kWh consumed: 1314 kWh
  = $166.87 ÷ 1314 = $0.127/kWh (approximate)
  
  CRITICAL: For bills with solar, IGNORE all "Generated" credits entirely.

Example (AEP Ohio / transmission-distribution bill):
  Previous Balance Due: $78.52 ← EXCLUDE (not current usage)
  Transmission Service: $27.02 ← INCLUDE (usage-based)
  Distribution Service: $41.49 ← INCLUDE (usage-based)
  Customer Charge: $10.00 ← EXCLUDE (fixed monthly fee)
  Current Electric Charges: $78.51 (this total INCLUDES the $10 customer charge)
  
  CORRECT CALCULATION:
  Usage-based only: $27.02 + $41.49 = $68.51
  Total kWh: 761
  = $68.51 ÷ 761 = $0.0900/kWh
  
  WRONG: Using $78.51 (includes fixed Customer Charge)
  WRONG: Including Previous Balance

CRITICAL: The goal is to capture the cost of electricity that solar panels will offset.
Fixed monthly fees remain whether or not you have solar, so they are excluded.

ALTERNATIVE METHOD (only if total bill not clear):
STEP 1: Calculate energy charges
- If TOU rates: Use weighted average based on kWh in each tier
- If flat rate: Use the stated rate

STEP 2: Add all per-kWh surcharges and fees

STEP 3: Add taxes
- Calculate total tax amount ($ amount, not just %)
- Divide by total kWh to get tax per kWh
- Add to the rate

ALWAYS INCLUDE:
- Energy charges at all tier rates
- All per-kWh fees and surcharges  
- ALL taxes (sales, city, state, municipal) - convert to $/kWh
- Fuel adjustments
- Environmental fees

ALWAYS EXCLUDE:
- Demand charges (based on peak kW)
- Fixed monthly service/meter fees
- One-time connection fees

FINAL REMINDER - CRITICAL RULES:
1. INCOME-BASED DISCOUNTS: If you see "Income Qualified Discount", "Low Income Discount", 
   "LIHEAP", or similar - DO NOT SUBTRACT THESE. Add up the base charges WITHOUT these discounts.
   Example: Current Service $69.29 + fees $10.14 = $79.42 (IGNORE the -$24 and -$9.50 income discounts)
   
2. SOLAR CREDITS: If you see "Generated" credits - IGNORE them entirely. Use only consumption charges.

3. DO NOT use "Total Current Electric Service" if it already has discounts subtracted.
   Instead, ADD UP the individual line items yourself, excluding income discounts.

Output ONLY valid JSON:
{
  "pricePerKwh": <number in USD, e.g., 0.1867>,
  "confidence": <number 0-1, e.g., 0.95>,
  "rationale": "<show your calculation step by step>"
}`;

  // Retry logic for transient API errors
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
      break; // Success, exit retry loop
    } catch (error) {
      lastError = error as Error;
      console.log(
        `Gemini API attempt ${attempt}/3 failed: ${lastError.message}`
      );
      if (attempt < 3) {
        const delay = attempt * 2000; // 2s, 4s backoff
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (!result) {
    throw new Error(
      `Gemini API failed after 3 attempts: ${lastError?.message}`
    );
  }

  const responseText = result.response.text();
  if (!responseText) {
    throw new Error("No response from Gemini for PDF extraction");
  }

  let extractedData: ElectricityPriceExtractionResult;
  try {
    // Strip markdown code blocks if present
    let cleanedResponse = responseText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "");

    // Find ALL pricePerKwh values - the AI sometimes reasons and updates the value
    const allPriceMatches = [
      ...cleanedResponse.matchAll(/"pricePerKwh"\s*:\s*(\d+\.?\d*)/g),
    ];

    // Also look for calculation patterns like "= $0.1817" or "/ 437 = $0.18175"
    const calcPatterns = [
      ...cleanedResponse.matchAll(/\/\s*\d+\s*(?:kWh)?\s*=\s*\$?(\d+\.\d+)/gi),
    ];

    // Also look for "Price per kWh = $X.XX" or "= $X.XX/kWh"
    const directPatterns = [
      ...cleanedResponse.matchAll(
        /(?:price per kWh|per kWh)\s*[=:]\s*\$?(\d+\.\d+)/gi
      ),
    ];

    let pricePerKwh: number | null = null;

    // Helper to check if price is reasonable (between $0.01 and $1.00 per kWh)
    const isReasonablePrice = (price: number) => price > 0.01 && price < 1.0;

    // Try JSON pricePerKwh field FIRST (most reliable if present and reasonable)
    if (allPriceMatches.length > 0) {
      const lastMatch = allPriceMatches[allPriceMatches.length - 1];
      const price = parseFloat(lastMatch[1]);
      if (isReasonablePrice(price)) {
        pricePerKwh = price;
      }
    }

    // Fall back to calculation pattern (e.g., "/ 437 = $0.1817")
    if (pricePerKwh === null && calcPatterns.length > 0) {
      const lastCalc = calcPatterns[calcPatterns.length - 1];
      const price = parseFloat(lastCalc[1]);
      if (isReasonablePrice(price)) {
        pricePerKwh = price;
      }
    }

    // Last resort: direct price statement (least reliable)
    if (pricePerKwh === null && directPatterns.length > 0) {
      const lastDirect = directPatterns[directPatterns.length - 1];
      const price = parseFloat(lastDirect[1]);
      if (isReasonablePrice(price)) {
        pricePerKwh = price;
      }
    }

    if (pricePerKwh === null) {
      throw new Error("No price found in response");
    }

    const confidenceMatch = cleanedResponse.match(
      /"confidence"\s*:\s*(\d+\.?\d*)/
    );
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.9;

    extractedData = {
      pricePerKwh,
      confidence,
      rationale: "Extracted from AI analysis",
    };
  } catch (parseError) {
    console.error("Failed to parse Gemini PDF response:", responseText);
    throw new Error(
      `Failed to parse electricity price from utility bill PDF: ${parseError}`
    );
  }

  // Check if extraction failed
  if (extractedData.pricePerKwh <= 0) {
    throw new Error(
      `Unable to extract electricity price from PDF: ${extractedData.rationale}`
    );
  }

  // Validate extraction quality
  if (extractedData.confidence < 0.5) {
    throw new Error(
      `Low confidence (${extractedData.confidence}) in extracted price from PDF: ${extractedData.rationale}`
    );
  }

  if (extractedData.pricePerKwh > 1.0) {
    throw new Error(
      `Extracted price ${extractedData.pricePerKwh} USD/kWh seems unreasonably high (>$1/kWh)`
    );
  }

  if (extractedData.pricePerKwh < 0.01) {
    throw new Error(
      `Extracted price ${extractedData.pricePerKwh} USD/kWh seems unreasonably low (<$0.01/kWh)`
    );
  }

  return { result: extractedData, billUrl };
}
