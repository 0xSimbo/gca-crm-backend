import { ApplicationSteps } from "../types/api-types/Application";

export const getStepNameFromIndex = (applicationStep: ApplicationSteps) => {
  switch (applicationStep) {
    case ApplicationSteps.enquiry:
      return "enquiry";
    case ApplicationSteps.preInstallDocuments:
      return "pre-install-documents";
    case ApplicationSteps.permitDocumentation:
      return "permit-documentation";
    case ApplicationSteps.inspectionAndPtoDocuments:
      return "inspection-and-pto-documents";
    case ApplicationSteps.payment:
      return "payment";
    default:
      return "unknown-step";
  }
};
