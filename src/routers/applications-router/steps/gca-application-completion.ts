import { completeApplicationWithDocumentsAndCreateFarmWithDevices } from "../../../db/mutations/applications/completeApplicationWithDocumentsAndCreateFarm";
import { ApplicationType, DocumentsInsertType } from "../../../db/schema";
import {
  ApplicationSteps,
  OptionalDocumentsNamesEnum,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";

type WithoutPiiDocumentsType = {
  contractAgreementPresignedUrl: string;
  declarationOfIntentionPresignedUrl: string;
  firstUtilityBillPresignedUrl: string;
  secondUtilityBillPresignedUrl: string;
  mortgageStatementPresignedUrl: string;
  propertyDeedPresignedUrl: string;
  plansetsPresignedUrl: string | null;
  permitPresignedUrl: string | null;
  inspectionPresignedUrl: string | null;
  ptoPresignedUrl: string | null;
  miscDocuments: {
    presignedUrl: string;
    documentName: string;
  }[];
};

export const handleCreateWithoutPIIDocumentsAndCompleteApplication = async (
  application: ApplicationType,
  gcaId: string,
  signature: string,
  step: ApplicationSteps,
  args: WithoutPiiDocumentsType & {
    devices: { publicKey: string; shortId: string }[];
  }
) => {
  const documents: DocumentsInsertType[] = [
    {
      name: RequiredDocumentsNamesEnum.contractAgreement,
      applicationId: application.id,
      url: args.contractAgreementPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.declarationOfIntention,
      applicationId: application.id,
      url: args.declarationOfIntentionPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.firstUtilityBill,
      applicationId: application.id,
      url: args.firstUtilityBillPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.secondUtilityBill,
      applicationId: application.id,
      url: args.secondUtilityBillPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.mortgageStatement,
      applicationId: application.id,
      url: args.mortgageStatementPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.propertyDeed,
      applicationId: application.id,
      url: args.propertyDeedPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  if (args.plansetsPresignedUrl) {
    documents.push({
      name: OptionalDocumentsNamesEnum.plansets,
      applicationId: application.id,
      url: args.plansetsPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.permitPresignedUrl) {
    documents.push({
      name: OptionalDocumentsNamesEnum.cityPermit,
      applicationId: application.id,
      url: args.permitPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.inspectionPresignedUrl) {
    documents.push({
      name: OptionalDocumentsNamesEnum.inspection,
      applicationId: application.id,
      url: args.inspectionPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.ptoPresignedUrl) {
    documents.push({
      name: OptionalDocumentsNamesEnum.pto,
      applicationId: application.id,
      url: args.ptoPresignedUrl,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  return await completeApplicationWithDocumentsAndCreateFarmWithDevices(
    application.id,
    gcaId,
    application.userId,
    signature,
    documents,
    args.devices
  );
};
