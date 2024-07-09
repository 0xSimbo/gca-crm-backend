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

export const handleCreateOrUpdatePreIntallDocuments = async (
  application: ApplicationType,
  organizationApplicationId: string | undefined,
  step: ApplicationSteps,
  args: UpdatePreInstallDocumentsRequiredType
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

  return await fillApplicationStepWithDocuments(
    organizationApplicationId,
    application.id,
    application.status,
    application.currentStep,
    documents,
    []
  );
};
