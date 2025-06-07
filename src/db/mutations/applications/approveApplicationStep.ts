import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationAuditFieldsCRSInsertType,
  ApplicationInsertType,
  ApplicationStepApprovals,
  applications,
  applicationsAuditFieldsCRS,
} from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const approveApplicationStep = async (
  applicationId: string,
  gcaAddress: string,
  annotation: string | null,
  stepIndex: number,
  signature: string,
  applicationFields: Partial<ApplicationInsertType>,
  applicationAuditFields?: ApplicationAuditFieldsCRSInsertType
) => {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(applications)
      .set({
        ...applicationFields,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });

    if (
      !res.every(
        ({ status }) =>
          status === ApplicationStatusEnum.approved ||
          status === ApplicationStatusEnum.draft
      )
    ) {
      tx.rollback(); // if fails will rollback and don't reach second tx
    }

    if (applicationAuditFields) {
      await tx.insert(applicationsAuditFieldsCRS).values({
        ...applicationAuditFields,
      });
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
