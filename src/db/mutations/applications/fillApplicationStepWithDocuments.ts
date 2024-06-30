import { and, count, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationInsertType,
  DelegatedDocumentsEncryptedMasterKeys,
  DelegatedDocumentsEncryptedMasterKeysInsertType,
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

export type DocumentsInsertTypeExtended = DocumentsInsertType & {
  orgMembersMasterkeys: {
    orgUserId: string;
    encryptedMasterKey: string;
  }[];
};

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
  organizationApplicationId: string | undefined,
  applicationId: string,
  status: ApplicationStatus,
  step: ApplicationSteps,
  documents: DocumentsInsertTypeExtended[],
  documentsMissingWithReason: DocumentsMissingWithReasonInsertType[],
  applicationFields?: Partial<ApplicationInsertType>
) => {
  let documentsInsert: { id: string }[] = [];

  await db.transaction(async (tx) => {
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

      if (
        documentsDelete.length !==
        documentsCountRes.reduce((acc, { count }) => acc + count, 0)
      ) {
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
        documentsMissingWithReasonCountRes.reduce(
          (acc, { count }) => acc + count,
          0
        )
      ) {
        tx.rollback();
      }
    }
    if (documents.length) {
      documentsInsert = await tx
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

  if (documents.length > 0 && organizationApplicationId) {
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i];
      if (!document.orgMembersMasterkeys) {
        continue;
      }
      // console.log(document.orgMembersMasterkeys);
      const documentId = documentsInsert[i].id;
      const delegatedDocumentsEncryptedMasterKeys: DelegatedDocumentsEncryptedMasterKeysInsertType[] =
        document.orgMembersMasterkeys.map(
          ({ orgUserId, encryptedMasterKey }) => ({
            organizationUserId: orgUserId,
            documentId,
            encryptedMasterKey,
            organizationApplicationId,
          })
        );
      // console.log(delegatedDocumentsEncryptedMasterKeys);
      if (delegatedDocumentsEncryptedMasterKeys.length > 0) {
        await db
          .insert(DelegatedDocumentsEncryptedMasterKeys)
          .values(delegatedDocumentsEncryptedMasterKeys);
      }
    }
  }
};
