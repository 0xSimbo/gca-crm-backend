export const stepStatus = [
  "draft",
  "approved",
  "changes-required",
  "waiting-for-approval",
  "completed",
  "quote-rejected",
  "waiting-for-information",
  "waiting-for-visit",
  "payment-confirmed",
] as const;

export const applicationStatus = [
  "waiting-to-be-assigned",
  "assigned",
  "completed",
];

export type StepStatus = (typeof stepStatus)[number];

export const contactTypes = ["telegram", "email", "discord"] as const;

export type ContactType = (typeof contactTypes)[number];

export enum ApplicationSteps {
  enquiry = 1,
  preInstallDocuments = 2,
  permitDocumentation = 3,
  inspectionAndPtoDocuments = 4,
  payment = 5,
}

export const ApplicationStepsLength = Object.keys(ApplicationSteps).length / 2;

export type ApplicationDocument = {
  id: string;
  name: string;
  url: string;
  key: string;
  step: ApplicationSteps;
  applicationId: string;
  annotation: string | null;
};

export const optionalDocuments = [
  "plansets",
  "city permit",
  "inspection",
  "pto",
] as const;

export type OptionalDocument = (typeof optionalDocuments)[number];

export type DocumentMissingWithReason = {
  documentName: OptionalDocument;
  reason: string;
  step: ApplicationSteps;
};

export type GCAStepAnnotation = {
  annotation: string;
  step: ApplicationSteps;
};

export type SolarInstallerDetails = {
  name: string;
  email: string;
  phone: string;
  companyName: string;
};

export type RewardSplit = {
  walletAddress: string;
  splitPercentage: string;
};

export type Application = {
  id: string;
  currentStep: ApplicationSteps;
  currentStepStatus: StepStatus;
  solarInstallerDetails: SolarInstallerDetails;
  address: string;
  lat: string;
  lng: string;
  establishedCostOfPowerPerKWh: string;
  estimatedKWhGeneratedPerYear: string;
  contactType: ContactType;
  contactValue: string;
  documentsMissingWithReason?: DocumentMissingWithReason[];
  annotations?: GCAStepAnnotation[];
  finalQuotePerWatt?: string;
  finalProtocolFee?: string;
  installDate?: string;
  installDateFinished?: string;
  preInstallVisitDateFrom?: string;
  preInstallVisitDateTo?: string;
  afterInstallVisitDateFrom?: string;
  afterInstallVisitDateTo?: string;
  rewardSplits?: RewardSplit[];
  paymentTxHash?: string;

  createdAt: string;
  updatedAt: string;
};
