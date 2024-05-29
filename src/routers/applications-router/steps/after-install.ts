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

type UpdateInspectionAndPtoType = {
  installFinishedDate: Date;
  inspection: EncryptedFileUploadType | null;
  pto: EncryptedFileUploadType | null;
  cityPermit: EncryptedFileUploadType | null;
  cityPermitNotAvailableReason: string | null;
  inspectionNotAvailableReason: string | null;
  firstUtilityBill: EncryptedFileUploadType;
  secondUtilityBill: EncryptedFileUploadType;
  mortgageStatement: EncryptedFileUploadType | null;
  propertyDeed: EncryptedFileUploadType | null;
  ptoNotAvailableReason: string | null;
  miscDocuments: {
    encryptedFileUpload: EncryptedFileUploadType;
    name: string;
    extension: string;
  }[];
};

export const handleCreateOrUpdateAfterInstallDocuments = async (
  application: ApplicationType,
  args: UpdateInspectionAndPtoType
) => {
  const step = ApplicationSteps.inspectionAndPtoDocuments;
  const documents: DocumentsInsertType[] = [
    {
      name: RequiredDocumentsNamesEnum.firstUtilityBill,
      applicationId: application.id,
      url: args.firstUtilityBill.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.firstUtilityBill.keysSet,
      createdAt: new Date(),
    },
    {
      name: RequiredDocumentsNamesEnum.secondUtilityBill,
      applicationId: application.id,
      url: args.secondUtilityBill.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.secondUtilityBill.keysSet,
      createdAt: new Date(),
    },
  ];

  if (args.mortgageStatement) {
    documents.push({
      name: RequiredDocumentsNamesEnum.mortgageStatement,
      applicationId: application.id,
      url: args.mortgageStatement.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.mortgageStatement.keysSet,
      createdAt: new Date(),
    });
  }

  if (args.propertyDeed) {
    documents.push({
      name: RequiredDocumentsNamesEnum.propertyDeed,
      applicationId: application.id,
      url: args.propertyDeed.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: args.propertyDeed.keysSet,
      createdAt: new Date(),
    });
  }

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
    { installFinishedDate: args.installFinishedDate }
  );
};
