import {
  DocumentsInsertTypeExtended,
  fillApplicationStepWithDocuments,
} from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import {
  ApplicationType,
  DocumentsMissingWithReasonInsertType,
} from "../../../db/schema";
import {
  ApplicationStatus,
  ApplicationSteps,
  OptionalDocumentsEnum,
  OptionalDocumentsNamesEnum,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../query-schemas";

type UpdateInspectionAndPtoType = {
  installFinishedDate: Date;
  inspection: EncryptedFileUploadType | null;
  pto: EncryptedFileUploadType | null;
  cityPermit: EncryptedFileUploadType | null;
  plansets: EncryptedFileUploadType | null;
  plansetsNotAvailableReason: string | null;
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
  application: {
    id: string;
    status: ApplicationStatus;
    currentStep: ApplicationSteps;
  },
  organizationApplicationId: string | undefined,
  args: UpdateInspectionAndPtoType
) => {
  const step = ApplicationSteps.inspectionAndPtoDocuments;
  const documents: DocumentsInsertTypeExtended[] = [
    {
      name: RequiredDocumentsNamesEnum.firstUtilityBill,
      applicationId: application.id,
      url: args.firstUtilityBill.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: [],
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
      encryptedMasterKeys: [],
      createdAt: new Date(),
    },
  ];

  if (args.mortgageStatement && args.mortgageStatement.publicUrl) {
    documents.push({
      name: RequiredDocumentsNamesEnum.mortgageStatement,
      applicationId: application.id,
      url: args.mortgageStatement.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.propertyDeed && args.propertyDeed.publicUrl) {
    documents.push({
      name: RequiredDocumentsNamesEnum.propertyDeed,
      applicationId: application.id,
      url: args.propertyDeed.publicUrl,
      type: "pdf",
      isEncrypted: true,
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
      url: args.inspection.publicUrl,
      type: "pdf",
      annotation: null,
      step: step,
      isEncrypted: true,
      encryptedMasterKeys: [],
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
      encryptedMasterKeys: [],
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
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }
  if (args.plansets) {
    documents.push({
      name: OptionalDocumentsNamesEnum.plansets,
      applicationId: application.id,
      url: args.plansets.publicUrl,
      type: "pdf",
      isEncrypted: true,
      annotation: null,
      step,
      encryptedMasterKeys: [],
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
    encryptedMasterKeys: [],
    createdAt: new Date(),
  }));

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
    documentsMissingWithReason,
    { installFinishedDate: args.installFinishedDate }
  );
};
