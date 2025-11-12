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
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

  const base64Pdf = fileBuffer.toString("base64");

  const prompt = `FIRST: Look at the bill for RED FLAGS indicating active solar panels.

REJECT if you find BOTH of these together:
1. RDA (Renewable Demand Adjustment) showing "-$" or "CR" (credit/negative)
AND
2. Very low consumption (under 500 kWh for 30 days for residential properties)

OR REJECT if you find ANY of these:
- Energy charges showing as credits or negative amounts
- Net metering credits listed
- Solar generation or export line items

If rejecting, output this JSON and STOP:
{
  "pricePerKwh": 0,
  "confidence": 0,
  "rationale": "REJECTED: Active solar detected. [State what you found]. Need pre-solar bill."
}

If NO red flags found → Continue to price extraction below.

---

PRICE EXTRACTION METHODOLOGY (only if bill passed rejection check above):

METHODOLOGY - Only Include Charges Affected by Solar:

STEP 1: Handle Time-of-Use (TOU) Rates
If the bill has multiple rate tiers (On-Peak, Mid-Peak, Off-Peak):
- Calculate the AVERAGE of all tier rates (not weighted, simple average)
- Example: (On-Peak $0.21 + Mid-Peak $0.14 + Off-Peak $0.08) / 3 = $0.143/kWh

STEP 2: Add Per-kWh Fees
INCLUDE these usage-based charges:
- Energy charges (base rate per kWh or TOU average)
- Fuel adjustment or surcharges (if per kWh)
- Power factor charges (if per kWh)
- Environmental fees (if per kWh)
- Transmission cost adjustments (if per kWh)
- Energy cost adjustments (if per kWh)
- Demand side management fees (if per kWh)
- Purchased capacity cost adjustments (if per kWh)
- City/Municipal sales taxes (ONLY if % of total bill)
- State taxes (ONLY if % of total bill)

EXCLUDE these fixed/demand charges:
- Demand charges (based on peak kW, not kWh)
- Delivery and transmission charges (if fixed/flat fee)
- Basic charges, meter fees, service charges (flat monthly)
- Administrative or regulatory charges (not per kWh)
- Connection fees

CALCULATION:
1. If TOU rates exist: Average them → Base Rate
2. Find all per-kWh fee amounts ($/kWh for each line item)
3. Sum: Total Price/kWh = Base Rate + All Per-kWh Fees

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
