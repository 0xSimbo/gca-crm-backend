import {
  DocumentsInsertTypeExtended,
  fillApplicationStepWithDocuments,
} from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import { ApplicationType } from "../../../db/schema";
import {
  ApplicationSteps,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../applicationsRouter";

export type declarationOfIntentionFieldsValueType = {
  fullname: string;
  latitude: string;
  longitude: string;
  date: number;
};
type UpdatePreInstallDocumentsRequiredType = {
  contractAgreement: EncryptedFileUploadType;
  declarationOfIntention: EncryptedFileUploadType;
  estimatedInstallDate: Date;
  declarationOfIntentionSignature: string;
  declarationOfIntentionFieldsValue: declarationOfIntentionFieldsValueType;
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
      encryptedMasterKeys: [],
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
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  return await fillApplicationStepWithDocuments(
    organizationApplicationId,
    application.id,
    application.status,
    application.currentStep,
    documents,
    [],
    {
      estimatedInstallDate: args.estimatedInstallDate,
      declarationOfIntentionSignature: args.declarationOfIntentionSignature,
      declarationOfIntentionFieldsValue: args.declarationOfIntentionFieldsValue,
      declarationOfIntentionSignatureDate: new Date(
        args.declarationOfIntentionFieldsValue.date * 1000
      ),
    }
  );
};
