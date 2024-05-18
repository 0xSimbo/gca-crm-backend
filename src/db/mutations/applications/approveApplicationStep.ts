import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationInsertType,
  ApplicationStepApprovals,
  applications,
} from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const approveApplicationStep = async (
  applicationId: string,
  gcaAddress: string,
  annotation: string | null,
  stepIndex: number,
  signature: string,
  applicationFields?: Partial<ApplicationInsertType>
) => {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.approved,
        ...applicationFields,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });

    if (!res.every(({ status }) => status === ApplicationStatusEnum.approved)) {
      tx.rollback(); // if fails will rollback and don't reach second tx
    }

    await tx.insert(ApplicationStepApprovals).values({
      applicationId,
      gcaAddress,
      annotation,
      step: stepIndex,
      approvedAt: new Date(),
      signature,
    });
  });
};
