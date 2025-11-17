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
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const base64Pdf = fileBuffer.toString("base64");

  const prompt = `FIRST: Check if this bill shows active solar panels already installed.

ONLY REJECT if you find ANY of these DEFINITIVE solar indicators:
1. Line items explicitly labeled "Solar Generation" or "Solar Export" 
2. Line items labeled "Energy Charge Generated" or "Generated" with CREDIT amounts (has "CR" or negative sign)
3. Net metering credits GREATER than $20
4. Large negative energy charges (credits GREATER than $50)

THESE ARE NOT SOLAR INDICATORS - ALWAYS ACCEPT:
- "Renewable Energy Adjustment" (RDA) or "Renewable Demand Adjustment" - utility rate adjustments
- "Renewable Energy" credits under $20 - utility program credits, not customer solar
- Small credits or adjustments under $20
- Normal positive energy charges
- No line items with "Generated" or "Solar Export"

CRITICAL EXAMPLES:
✅ ACCEPT: "Renewable Energy Adjustment: -$0.20" (utility rate adjustment, NOT solar)
✅ ACCEPT: "Renewable Demand Adjustment: -$5.00" (utility program, NOT solar)
❌ REJECT: "Energy Charge Generated: $150.00CR" (customer solar generation)
❌ REJECT: "Solar Export Credit: $45.00" (customer solar generation)

If you find definitive solar evidence (Generated/Export line items), output this JSON and STOP:
{
  "pricePerKwh": 0,
  "confidence": 0,
  "rationale": "REJECTED: Active solar detected. Found [specific evidence like 'Energy Charge Generated credit of $X']. Need pre-solar bill."
}

If NO solar evidence found (normal bill) → Continue to price extraction below.

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
✅ Time-of-Use (TOU) rates
✅ Fuel Adjustment or Surcharges (if tied to usage)
✅ Environmental fees (if per kWh)
✅ Power factor incentives/penalties (if usage-based)
✅ City/Municipal Sales Taxes (if % of total bill)
✅ State Taxes (if % of total bill)
✅ Renewable Energy Adjustment (usage-based rate adjustment)
✅ Energy Balancing Account (usage-based adjustment)
✅ Customer Efficiency Services (if usage-based)

STEP 3: EXCLUDE (Subtract) - Fixed charges NOT affected by solar:
❌ Basic Charge / Customer Charge / Service Charge (flat monthly fee)
❌ Meter Fees (fixed)
❌ Demand Charges (based on peak kW, not affected by solar)
❌ Delivery and Transmission Charges (grid infrastructure, not usage-based)
❌ Administrative or Regulatory Charges (fixed)
❌ Assistance program credits (e.g., "Home Electric Lifeline Program")
❌ Non-electric utilities (Water, Sewer, Storm water, Garbage, etc.)

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

Output ONLY valid JSON:
{
  "pricePerKwh": <number in USD, e.g., 0.1867>,
  "confidence": <number 0-1, e.g., 0.95>,
  "rationale": "<Base rate calculation (show TOU averaging if applicable) + list of per-kWh fees included + charges excluded>"
}`;

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        mimeType: "application/pdf",
        data: base64Pdf,
      },
    },
  ]);

  const responseText = result.response.text();
  if (!responseText) {
    throw new Error("No response from Gemini for PDF extraction");
  }

  let extractedData: ElectricityPriceExtractionResult;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    const parsed = JSON.parse(jsonMatch[0]);
    extractedData = {
      pricePerKwh: Number(parsed.pricePerKwh),
      confidence: Number(parsed.confidence),
      rationale: String(parsed.rationale || ""),
    };
  } catch (parseError) {
    console.error("Failed to parse Gemini PDF response:", responseText);
    throw new Error(
      `Failed to parse electricity price from utility bill PDF: ${parseError}`
    );
  }

  // Check if bill was rejected (active solar installation detected)
  if (extractedData.pricePerKwh <= 0 && extractedData.confidence === 0) {
    if (extractedData.rationale.includes("REJECTED")) {
      throw new Error(extractedData.rationale);
    }
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
