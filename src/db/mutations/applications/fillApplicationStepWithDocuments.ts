import { and, count, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationInsertType,
  Documents,
  DocumentsInsertType,
  DocumentsMissingWithReason,
  DocumentsMissingWithReasonInsertType,
  applications,
} from "../../schema";
import {
  ApplicationStatus,
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../../types/api-types/Application";

/**
 * Fills an application step with documents atomically.
 *
 * @param applicationId - The ID of the application.
 * @param status - The status of the application.
 * @param step - The step of the application.
 * @param documents - The documents to insert.
 * @param documentsMissingWithReason - The documents missing with reason to insert.
 * @param applicationFields - The application fields to update (optional).
 */
export const fillApplicationStepWithDocuments = async (
  applicationId: string,
  status: ApplicationStatus,
  step: ApplicationSteps,
  documents: DocumentsInsertType[],
  documentsMissingWithReason: DocumentsMissingWithReasonInsertType[],
  applicationFields?: Partial<ApplicationInsertType>
) => {
  return db.transaction(async (tx) => {
    if (status === ApplicationStatusEnum.changesRequired) {
      const documentsCountRes = await tx
        .select({ count: count(Documents.id) })
        .from(Documents)
        .where(
          and(
            eq(Documents.applicationId, applicationId),
            eq(Documents.step, step)
          )
        );

      const documentsDelete = await tx
        .delete(Documents)
        .where(
          and(
            eq(Documents.applicationId, applicationId),
            eq(Documents.step, step)
          )
        )
        .returning({ id: Documents.id });

      if (documentsDelete.length !== documentsCountRes[0].count) {
        tx.rollback();
      }

      const documentsMissingWithReasonCountRes = await tx
        .select({ count: count(DocumentsMissingWithReason.id) })
        .from(DocumentsMissingWithReason)
        .where(
          and(
            eq(DocumentsMissingWithReason.applicationId, applicationId),
            eq(DocumentsMissingWithReason.step, step)
          )
        );

      const documentsMissingWithReasonDelete = await tx
        .delete(DocumentsMissingWithReason)
        .where(
          and(
            eq(DocumentsMissingWithReason.applicationId, applicationId),
            eq(DocumentsMissingWithReason.step, step)
          )
        )
        .returning({ id: DocumentsMissingWithReason.id });

      if (
        documentsMissingWithReasonDelete.length !==
        documentsMissingWithReasonCountRes[0].count
      ) {
        tx.rollback();
      }
    }
    if (documents.length) {
      const documentsInsert = await tx
        .insert(Documents)
        .values(documents)
        .returning({ id: Documents.id });

      if (documentsInsert.length !== documents.length) {
        tx.rollback();
      }
    }

    if (documentsMissingWithReason.length) {
      if (documentsMissingWithReason.length > 0) {
        const documentsMissingWithReasonInsert = await tx
          .insert(DocumentsMissingWithReason)
          .values(documentsMissingWithReason)
          .returning({ id: DocumentsMissingWithReason.id });
        if (
          documentsMissingWithReasonInsert.length !==
          documentsMissingWithReason.length
        ) {
          tx.rollback();
        }
      }
    }

    const applicationUpdateStatus = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.waitingForApproval,
        ...applicationFields,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });
    if (
      !applicationUpdateStatus.every(
        ({ status }) => status === ApplicationStatusEnum.waitingForApproval
      )
    ) {
      tx.rollback();
    }
  });
};
