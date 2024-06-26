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
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../applicationsRouter";

type UpdatePreInstallDocumentsRequiredType = {
  contractAgreement: EncryptedFileUploadType;
  declarationOfIntention: EncryptedFileUploadType;
};

type UpdatePreInstallDocumentsWithPlansetsNotAvailableType =
  UpdatePreInstallDocumentsRequiredType & {
    plansets: null;
    plansetsNotAvailableReason: string;
  };

type UpdatePreInstallDocumentsWithPlansetsAvailableType =
  UpdatePreInstallDocumentsRequiredType & {
    plansets: EncryptedFileUploadType;
    plansetsNotAvailableReason: null;
  };

export const handleCreateOrUpdatePreIntallDocuments = async (
  application: ApplicationType,
  step: ApplicationSteps,
  args:
    | UpdatePreInstallDocumentsWithPlansetsNotAvailableType
    | UpdatePreInstallDocumentsWithPlansetsAvailableType
) => {
  const documents: DocumentsInsertType[] = [
    {
      name: RequiredDocumentsNamesEnum.contractAgreement,
      applicationId: application.id,
      url: args.contractAgreement.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.contractAgreement.keysSet,
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.declarationOfIntention,
      applicationId: application.id,
      url: args.declarationOfIntention.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.declarationOfIntention.keysSet,
      createdAt: new Date(),
    },
  ];

  if (args.plansets) {
    documents.push({
      name: OptionalDocumentsNamesEnum.plansets,
      applicationId: application.id,
      url: args.plansets.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.plansets.keysSet,
      createdAt: new Date(),
    });
  }
  const documentsMissingWithReason: DocumentsMissingWithReasonInsertType[] = [];

  if (args.plansetsNotAvailableReason) {
    documentsMissingWithReason.push({
      applicationId: application.id,
      documentName: OptionalDocumentsEnum.plansets,
      reason: args.plansetsNotAvailableReason,
      step,
    });
  }

  return await fillApplicationStepWithDocuments(
    application.id,
    application.status,
    application.currentStep,
    documents,
    documentsMissingWithReason
  );
};
