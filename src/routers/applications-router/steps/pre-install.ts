import { and, count, eq } from "drizzle-orm";
import { db } from "../../../db/db";
import {
  DocumentsInsertTypeExtended,
  fillApplicationStepWithDocuments,
} from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import {
  applications,
  applicationsEnquiryFieldsCRS,
  ApplicationType,
  Documents,
  DocumentsMissingWithReason,
} from "../../../db/schema";
import {
  ApplicationStatus,
  ApplicationStatusEnum,
  ApplicationSteps,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../query-schemas";

type UpdatePreInstallDocumentsRequiredType = {
  contractAgreement: EncryptedFileUploadType;
  estimatedInstallDate: Date;
  zoneId: number;
  certifiedInstallerId?: string;
};

export const handleCreateOrUpdatePreIntallDocuments = async (
  application: {
    id: string;
    status: ApplicationStatus;
    currentStep: ApplicationSteps;
  },
  step: ApplicationSteps,
  args: UpdatePreInstallDocumentsRequiredType,
  applicationEnquiryFields: {
    installerName: string;
    installerCompanyName: string;
    installerEmail: string;
    installerPhone: string;
  }
) => {
  const documents: DocumentsInsertTypeExtended[] = [
    {
      name: RequiredDocumentsNamesEnum.contractAgreement,
      applicationId: application.id,
      url: args.contractAgreement.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  let documentsInsert: { id: string }[] = [];
  await db.transaction(async (tx) => {
    if (application.status === ApplicationStatusEnum.changesRequired) {
      const documentsCountRes = await tx
        .select({ count: count(Documents.id) })
        .from(Documents)
        .where(
          and(
            eq(Documents.applicationId, application.id),
            eq(Documents.step, step)
          )
        );

      const documentsDelete = await tx
        .delete(Documents)
        .where(
          and(
            eq(Documents.applicationId, application.id),
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
            eq(DocumentsMissingWithReason.applicationId, application.id),
            eq(DocumentsMissingWithReason.step, step)
          )
        );

      const documentsMissingWithReasonDelete = await tx
        .delete(DocumentsMissingWithReason)
        .where(
          and(
            eq(DocumentsMissingWithReason.applicationId, application.id),
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

    await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.waitingForApproval,
        ...args,
      })
      .where(and(eq(applications.id, application.id)))
      .returning({ status: applications.status });

    await tx
      .update(applicationsEnquiryFieldsCRS)
      .set({
        ...applicationEnquiryFields,
      })
      .where(eq(applicationsEnquiryFieldsCRS.applicationId, application.id));
  });
};
