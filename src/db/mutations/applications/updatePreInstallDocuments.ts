import { and, count, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationStepApprovals,
  Documents,
  DocumentsInsertType,
  DocumentsMissingWithReason,
  DocumentsMissingWithReasonInsertType,
  DocumentsType,
  applications,
} from "../../schema";
import {
  ApplicationStatus,
  ApplicationStatusEnum,
  ApplicationSteps,
  OptionalDocumentsEnum,
} from "../../../types/api-types/Application";

type UpdatePreInstallDocumentsRequiredType = {
  contractAgreementPresignedUrl: string;
  declarationOfIntentionPresignedUrl: string;
  firstUtilityBillPresignedUrl: string;
  secondUtilityBillPresignedUrl: string;
  mortgageStatementPresignedUrl: string;
  propertyDeedPresignedUrl: string;
};

type UpdatePreInstallDocumentsWithPlansetsNotAvailableType =
  UpdatePreInstallDocumentsRequiredType & {
    plansetsPresignedUrl: null;
    plansetsNotAvailableReason: string;
  };

type UpdatePreInstallDocumentsWithPlansetsAvailableType =
  UpdatePreInstallDocumentsRequiredType & {
    plansetsPresignedUrl: string;
    plansetsNotAvailableReason: null;
  };

/**
 * Updates or crate the pre-install documents for an application atomically.
 *
 * @param applicationId - The ID of the application.
 * @param status - The status of the application.
 * @param args - The arguments containing the URLs and other details of the pre-install documents.
 * @returns A Promise that resolves when the update is complete.
 */
export const updatePreInstallDocuments = async (
  applicationId: string,
  status: ApplicationStatus,
  args:
    | UpdatePreInstallDocumentsWithPlansetsNotAvailableType
    | UpdatePreInstallDocumentsWithPlansetsAvailableType
) => {
  const documents: DocumentsInsertType[] = [
    {
      name: "Contract Agreement",
      applicationId,
      url: args.contractAgreementPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
    {
      name: "Declaration of Intention",
      applicationId,
      url: args.declarationOfIntentionPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
    {
      name: "First Utility Bill",
      applicationId,
      url: args.firstUtilityBillPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
    {
      name: "Second Utility Bill",
      applicationId,
      url: args.secondUtilityBillPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
    {
      name: "Mortgage Statement",
      applicationId,
      url: args.mortgageStatementPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
    {
      name: "Property Deed",
      applicationId,
      url: args.propertyDeedPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    },
  ];

  if (args.plansetsPresignedUrl) {
    documents.push({
      name: "Plansets",
      applicationId,
      url: args.plansetsPresignedUrl,
      type: "enc",
      annotation: null,
      step: ApplicationSteps.preInstallDocuments,
      encryptedMasterKeys: [],
    });
  }
  const documentsMissingWithReason: DocumentsMissingWithReasonInsertType[] = [];

  if (args.plansetsNotAvailableReason) {
    documentsMissingWithReason.push({
      applicationId,
      documentName: OptionalDocumentsEnum.plansets,
      reason: args.plansetsNotAvailableReason,
      step: ApplicationSteps.preInstallDocuments,
    });
  }

  return db.transaction(async (tx) => {
    if (status === ApplicationStatusEnum.changesRequired) {
      const documentsCountRes = await tx
        .select({ count: count(Documents.id) })
        .from(Documents)
        .where(
          and(
            eq(Documents.applicationId, applicationId),
            eq(Documents.step, ApplicationSteps.preInstallDocuments)
          )
        );

      const documentsDelete = await tx
        .delete(Documents)
        .where(
          and(
            eq(Documents.applicationId, applicationId),
            eq(Documents.step, ApplicationSteps.preInstallDocuments)
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
            eq(
              DocumentsMissingWithReason.step,
              ApplicationSteps.preInstallDocuments
            )
          )
        );

      const documentsMissingWithReasonDelete = await tx
        .delete(DocumentsMissingWithReason)
        .where(
          and(
            eq(DocumentsMissingWithReason.applicationId, applicationId),
            eq(
              DocumentsMissingWithReason.step,
              ApplicationSteps.preInstallDocuments
            )
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
    const documentsInsert = await tx
      .insert(Documents)
      .values(documents)
      .returning({ id: Documents.id });

    if (documentsInsert.length !== documents.length) {
      tx.rollback();
    }

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

    const applicationUpdateStatus = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.approved,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });
    if (
      !applicationUpdateStatus.every(
        ({ status }) => status === ApplicationStatusEnum.approved
      )
    ) {
      tx.rollback();
    }
  });
};
