import { eq } from "drizzle-orm";
import { db } from "../../db";
import { farms } from "../../schema";

export const findUsedTxHash = async (txHash: string) => {
  const usedTxHash = await db.query.farms.findFirst({
    where: eq(farms.protocolFeePaymentHash, txHash),
  });
  return usedTxHash;
};
