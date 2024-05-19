import { fillApplicationStepWithDocuments } from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import {
  ApplicationType,
  DocumentsInsertType,
  DocumentsMissingWithReasonInsertType,
} from "../../../db/schema";
import {
  ApplicationSteps,
  OptionalDocumentsEnum,
} from "../../../types/api-types/Application";

type UpdatePermitDocumentationRequiredType = {
  estimatedInstallDate: Date;
};

type UpdatePermitDocumentationWithCityPermitNotAvailableType =
  UpdatePermitDocumentationRequiredType & {
    cityPermitPresignedUrl: null;
    cityPermitNotAvailableReason: string;
  };

type UpdatePermitDocumentationWithCityPermitAvailableType =
  UpdatePermitDocumentationRequiredType & {
    cityPermitPresignedUrl: string;
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

  if (args.cityPermitPresignedUrl) {
    documents.push({
      name: "City Permit",
      applicationId: application.id,
      url: args.cityPermitPresignedUrl,
      type: "enc",
      annotation: null,
      step: step,
      encryptedMasterKeys: [],
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
