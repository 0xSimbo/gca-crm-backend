import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications, deferments } from "../../schema";
import { RoundRobinStatusEnum } from "../../../types/api-types/Application";

export const deferApplicationAssignement = async (
  applicationId: string,
  fromGcaAddress: string,
  toGcaAddress: string,
  reason: string | null,
  defermentSignature: string
) => {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(applications)
      .set({
        roundRobinStatus: RoundRobinStatusEnum.waitingToBeAccepted,
        gcaAcceptanceTimestamp: null,
        gcaAddress: toGcaAddress,
        gcaAssignedTimestamp: new Date(),
        gcaAcceptanceSignature: null,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ roundRobinStatus: applications.roundRobinStatus });

    if (
      !res.every(
        ({ roundRobinStatus }) =>
          roundRobinStatus === RoundRobinStatusEnum.waitingToBeAccepted
      )
    ) {
      tx.rollback(); // if fails will rollback and don't reach second tx
    }

    await tx.insert(deferments).values({
      applicationId,
      fromGca: fromGcaAddress,
      toGca: toGcaAddress,
      reason,
      timestamp: new Date(),
      defermentSignature,
    });
  });
};
