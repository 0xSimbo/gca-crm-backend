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

type UpdatePermitDocumentationRequiredType = {
  estimatedInstallDate: Date;
};

type UpdatePermitDocumentationWithCityPermitNotAvailableType =
  UpdatePermitDocumentationRequiredType & {
    cityPermit: null;
    cityPermitNotAvailableReason: string;
  };

type UpdatePermitDocumentationWithCityPermitAvailableType =
  UpdatePermitDocumentationRequiredType & {
    cityPermit: EncryptedFileUploadType;
    cityPermitNotAvailableReason: null;
  };

export const handleCreateOrUpdatePermitDocumentation = async (
  application: ApplicationType,
  step: ApplicationSteps,
  args:
    | UpdatePermitDocumentationWithCityPermitNotAvailableType
    | UpdatePermitDocumentationWithCityPermitAvailableType
) => {
  const documents: DocumentsInsertType[] = [];

  if (args.cityPermit) {
    documents.push({
      name: OptionalDocumentsNamesEnum.cityPermit,
      applicationId: application.id,
      url: args.cityPermit.publicUrl,
      type: "pdf",
      annotation: null,
      step: step,
      isEncrypted: true,
      encryptedMasterKeys: args.cityPermit.keysSet,
      createdAt: new Date(),
    });
  }

  const documentsMissingWithReason: DocumentsMissingWithReasonInsertType[] = [];

  if (args.cityPermitNotAvailableReason) {
    documentsMissingWithReason.push({
      applicationId: application.id,
      documentName: OptionalDocumentsEnum.cityPermit,
      reason: args.cityPermitNotAvailableReason,
      step: step,
    });
  }

  return await fillApplicationStepWithDocuments(
    application.id,
    application.status,
    application.currentStep,
    documents,
    documentsMissingWithReason,
    { estimatedInstallDate: args.estimatedInstallDate }
  );
};
