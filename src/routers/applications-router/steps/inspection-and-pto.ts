import { fillApplicationStepWithDocuments } from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import {
  ApplicationType,
  DocumentsInsertType,
  DocumentsMissingWithReasonInsertType,
} from "../../../db/schema";
import {
  ApplicationSteps,
  OptionalDocumentsEnum,
  OptionalDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../applicationsRouter";

type UpdateInspectionAndPtoType = {
  intallFinishedDate: Date;
  inspection: EncryptedFileUploadType | null;
  pto: EncryptedFileUploadType | null;
  inspectionNotAvailableReason: string | null;
  ptoNotAvailableReason: string | null;
  miscDocuments: {
    encryptedFileUpload: EncryptedFileUploadType;
    name: string;
    extension: string;
  }[];
};

export const handleCreateOrUpdateInspectionAndPto = async (
  application: ApplicationType,
  args: UpdateInspectionAndPtoType
) => {
  const documents: DocumentsInsertType[] = [];
  const step = ApplicationSteps.inspectionAndPtoDocuments;

  if (args.inspection) {
    documents.push({
      name: OptionalDocumentsNamesEnum.inspection,
      applicationId: application.id,
      url: args.inspection.publicUrl,
      type: "pdf",
      annotation: null,
      step: step,
      isEncrypted: true,
      encryptedMasterKeys: args.inspection.keysSet,
      createdAt: new Date(),
    });
  }

  if (args.pto) {
    documents.push({
      name: OptionalDocumentsNamesEnum.pto,
      applicationId: application.id,
      url: args.pto.publicUrl,
      type: "pdf",
      annotation: null,
      step: step,
      isEncrypted: true,
      encryptedMasterKeys: args.pto.keysSet,
      createdAt: new Date(),
    });
  }

  const miscDocuments = args.miscDocuments.map((misc) => ({
    name: misc.name,
    applicationId: application.id,
    url: misc.encryptedFileUpload.publicUrl,
    type: misc.extension,
    annotation: null,
    step: step,
    isEncrypted: true,
    encryptedMasterKeys: misc.encryptedFileUpload.keysSet,
    createdAt: new Date(),
  }));
  console.log(miscDocuments);

  if (miscDocuments.length > 0) {
    documents.push(...miscDocuments);
  }

  const documentsMissingWithReason: DocumentsMissingWithReasonInsertType[] = [];

  if (args.inspectionNotAvailableReason) {
    documentsMissingWithReason.push({
      applicationId: application.id,
      documentName: OptionalDocumentsEnum.inspection,
      reason: args.inspectionNotAvailableReason,
      step: step,
    });
  }

  if (args.ptoNotAvailableReason) {
    documentsMissingWithReason.push({
      applicationId: application.id,
      documentName: OptionalDocumentsEnum.pto,
      reason: args.ptoNotAvailableReason,
      step: step,
    });
  }

  return await fillApplicationStepWithDocuments(
    application.id,
    application.status,
    application.currentStep,
    documents,
    documentsMissingWithReason,
    { intallFinishedDate: args.intallFinishedDate }
  );
};
