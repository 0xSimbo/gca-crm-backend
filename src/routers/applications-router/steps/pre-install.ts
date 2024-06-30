import {
  DocumentsInsertTypeExtended,
  fillApplicationStepWithDocuments,
} from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import {
  ApplicationType,
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
  organizationApplicationId: string | undefined,
  step: ApplicationSteps,
  args:
    | UpdatePreInstallDocumentsWithPlansetsNotAvailableType
    | UpdatePreInstallDocumentsWithPlansetsAvailableType
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
      encryptedMasterKeys: args.contractAgreement.keysSet,
      createdAt: new Date(),
      orgMembersMasterkeys: args.contractAgreement.orgMembersMasterkeys,
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
      orgMembersMasterkeys: args.declarationOfIntention.orgMembersMasterkeys,
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
      orgMembersMasterkeys: args.plansets.orgMembersMasterkeys,
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
    organizationApplicationId,
    application.id,
    application.status,
    application.currentStep,
    documents,
    documentsMissingWithReason
  );
};
