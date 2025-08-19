import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications, farms } from "../../schema";

export const findUsedTxHash = async (txHash: string) => {
  const usedTxHash = await db.query.farms.findFirst({
    where: eq(farms.protocolFeePaymentHash, txHash),
  });
  return usedTxHash;
};

export const findUsedAuditFeesTxHash = async (txHash: string) => {
  const usedTxHash = await db.query.applications.findFirst({
    where: eq(applications.auditFeesTxHash, txHash),
  });
  return usedTxHash;
};
