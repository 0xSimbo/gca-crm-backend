import { verifyMessage } from "ethers";

export interface QuoteSignatureMessage {
  weeklyConsumptionMWh: string;
  systemSizeKw: string;
  latitude: string;
  longitude: string;
  timestamp: number;
}

export function createMessageToSign(data: QuoteSignatureMessage): string {
  return `${data.weeklyConsumptionMWh},${data.systemSizeKw},${data.latitude},${data.longitude},${data.timestamp}`;
}

export function verifyQuoteSignature(
  message: QuoteSignatureMessage,
  signature: string
): string {
  const messageToVerify = createMessageToSign(message);
  const recoveredAddress = verifyMessage(messageToVerify, signature);
  return recoveredAddress;
}

export function validateTimestamp(timestamp: number): void {
  const now = Date.now();
  const timestampAge = now - timestamp;

  // Allow signatures within 5 minutes (300,000 ms)
  const maxAge = 5 * 60 * 1000;

  if (timestampAge > maxAge) {
    throw new Error("Signature timestamp expired. Please sign a new message.");
  }

  if (timestampAge < 0) {
    throw new Error(
      "Signature timestamp is in the future. Please check your system time."
    );
  }
}

export function createBatchMessageToSign(batchId: string, timestamp: number): string {
  return `${batchId},${timestamp}`;
}

export function verifyBatchSignature(
  batchId: string,
  timestamp: number,
  signature: string
): string {
  const messageToVerify = createBatchMessageToSign(batchId, timestamp);
  return verifyMessage(messageToVerify, signature);
}
