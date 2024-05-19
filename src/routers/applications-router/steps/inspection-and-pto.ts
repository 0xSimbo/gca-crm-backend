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

type UpdateInspectionAndPtoType = {
  intallFinishedDate: Date;
  inspectionPresignedUrl: string | null;
  ptoPresignedUrl: string | null;
  inspectionNotAvailableReason: string | null;
  ptoNotAvailableReason: string | null;
  miscDocuments: { presignedUrl: string; name: string }[];
};

export const handleCreateOrUpdateInspectionAndPto = async (
  application: ApplicationType,
  args: UpdateInspectionAndPtoType
) => {
  const documents: DocumentsInsertType[] = [];
  const step = ApplicationSteps.inspectionAndPtoDocuments;

  if (args.inspectionPresignedUrl) {
    documents.push({
      name: "Inspection",
      applicationId: application.id,
      url: args.inspectionPresignedUrl,
      type: "enc",
      annotation: null,
      step: step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  if (args.ptoPresignedUrl) {
    documents.push({
      name: "Permission to Operate (PTO)",
      applicationId: application.id,
      url: args.ptoPresignedUrl,
      type: "enc",
      annotation: null,
      step: step,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    });
  }

  const miscDocuments = args.miscDocuments.map((misc) => ({
    name: misc.name,
    applicationId: application.id,
    url: misc.presignedUrl,
    type: "enc",
    annotation: null,
    step: step,
    encryptedMasterKeys: [],
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

  return await fillApplicationStepWithDocuments(
    application.id,
    application.status,
    application.currentStep,
    documents,
    documentsMissingWithReason,
    { intallFinishedDate: args.intallFinishedDate }
  );
};
