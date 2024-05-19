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

export const handleCreateOrUpdatePreIntallDocuments = async (
  application: ApplicationType,
  step: ApplicationSteps,
  args:
    | UpdatePreInstallDocumentsWithPlansetsNotAvailableType
    | UpdatePreInstallDocumentsWithPlansetsAvailableType
) => {
  const documents: DocumentsInsertType[] = [
    {
      name: "Contract Agreement",
      applicationId: application.id,
      url: args.contractAgreementPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: "Declaration of Intention",
      applicationId: application.id,
      url: args.declarationOfIntentionPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: "First Utility Bill",
      applicationId: application.id,
      url: args.firstUtilityBillPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: "Second Utility Bill",
      applicationId: application.id,
      url: args.secondUtilityBillPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: "Mortgage Statement",
      applicationId: application.id,
      url: args.mortgageStatementPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: "Property Deed",
      applicationId: application.id,
      url: args.propertyDeedPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  if (args.plansetsPresignedUrl) {
    documents.push({
      name: "Plansets",
      applicationId: application.id,
      url: args.plansetsPresignedUrl,
      type: "enc",
      annotation: null,
      step,
      encryptedMasterKeys: [],
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
