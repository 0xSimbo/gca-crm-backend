import { completeApplicationWithDocumentsAndCreateFarmWithDevices } from "../../../db/mutations/applications/completeApplicationWithDocumentsAndCreateFarm";
import { ApplicationType, DocumentsInsertType } from "../../../db/schema";
import {
  ApplicationSteps,
  OptionalDocumentsNamesEnum,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
type WithoutPiiDocumentsType = {
  contractAgreement: string;
  declarationOfIntention: string;
  firstUtilityBill: string;
  secondUtilityBill: string;
  mortgageStatement: string;
  propertyDeed: string;
  plansets: string | null;
  cityPermit: string | null;
  inspection: string | null;
  pto: string | null;
};

export const handleCreateWithoutPIIDocumentsAndCompleteApplication = async (
  application: ApplicationType,
  gcaId: string,
  signature: string,
  step: ApplicationSteps,
  args: WithoutPiiDocumentsType & {
    finalAuditReport: string;
    devices: { publicKey: string; shortId: string }[];
    miscDocuments: {
      publicUrl: string;
      documentName: string;
      extension: string;
    }[];
  }
) => {
  const documents: DocumentsInsertType[] = [
    {
      name: RequiredDocumentsNamesEnum.finalAuditReport,
      applicationId: application.id,
      url: args.finalAuditReport,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.contractAgreement,
      applicationId: application.id,
      url: args.contractAgreement,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.declarationOfIntention,
      applicationId: application.id,
      url: args.declarationOfIntention,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.firstUtilityBill,
      applicationId: application.id,
      url: args.firstUtilityBill,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.secondUtilityBill,
      applicationId: application.id,
      url: args.secondUtilityBill,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.mortgageStatement,
      applicationId: application.id,
      url: args.mortgageStatement,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.propertyDeed,
      applicationId: application.id,
      url: args.propertyDeed,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  if (args.plansets) {
    documents.push({
      name: OptionalDocumentsNamesEnum.plansets,
      applicationId: application.id,
      url: args.plansets,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.cityPermit) {
    documents.push({
      name: OptionalDocumentsNamesEnum.cityPermit,
      applicationId: application.id,
      url: args.cityPermit,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.inspection) {
    documents.push({
      name: OptionalDocumentsNamesEnum.inspection,
      applicationId: application.id,
      url: args.inspection,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.pto) {
    documents.push({
      name: OptionalDocumentsNamesEnum.pto,
      applicationId: application.id,
      url: args.pto,
      type: "pdf",
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.miscDocuments) {
    documents.push(
      ...args.miscDocuments.map((misc) => ({
        name: misc.documentName,
        applicationId: application.id,
        url: misc.publicUrl,
        type: misc.extension,
        annotation: null,
        step: step,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      }))
    );
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
