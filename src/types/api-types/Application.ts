export type EncryptedMasterKeySet = {
  publicKey: string;
  encryptedMasterKey: string;
};

export const applicationStatus = [
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

export enum ApplicationStatusEnum {
  draft = "draft",
  approved = "approved",
  changesRequired = "changes-required",
  waitingForApproval = "waiting-for-approval",
  completed = "completed",
  quoteRejected = "quote-rejected",
  waitingForInformation = "waiting-for-information",
  waitingForVisit = "waiting-for-visit",
  paymentConfirmed = "payment-confirmed",
}

export const roundRobinStatus = [
  "waiting-to-be-assigned",
  "waiting-to-be-accepted",
  "assigned",
] as const;

export enum RoundRobinStatusEnum {
  waitingToBeAssigned = "waiting-to-be-assigned",
  waitingToBeAccepted = "waiting-to-be-accepted",
  assigned = "assigned",
}

export type RoundRobinStatus = (typeof roundRobinStatus)[number];

export type ApplicationStatus = (typeof applicationStatus)[number];

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

export type Deferment = {
  id: string;
  applicationId: string;
  reason: string;
  fromGca: string;
  toGca: string;
  timestamp: string;
};

export type ApplicationDocument = {
  id: string;
  name: string;
  url: string;
  type: string;
  key: string;
  step: ApplicationSteps;
  applicationId: string;
  annotation: string | null;
  encryptedMasterKeys: EncryptedMasterKeySet[];
};

export const optionalDocuments = [
  "plansets",
  "city permit",
  "inspection",
  "pto",
] as const;

export type OptionalDocument = (typeof optionalDocuments)[number];

export type DocumentMissingWithReason = {
  id: string;
  applicationId: string;
  documentName: OptionalDocument;
  reason: string;
  step: ApplicationSteps;
};

export type GCAStepAnnotation = {
  id: string;
  applicationId: string;
  annotation: string;
  step: ApplicationSteps;
};

export type SolarInstallerDetails = {
  id: string;
  name: string;
  email: string;
  phone: string;
  companyName: string;
};

export const splitTokens = ["USDG", "GLOW"] as const;

export type RewardSplit = {
  id: string;
  farmId?: string; // farmId can be null if the application is not yet completed, it's being patched after the farm is created.
  applicationId: string;
  walletAddress: string;
  splitPercentage: string;
  token: (typeof splitTokens)[number];
};

export type Application = {
  id: string;
  userId: string;
  installerId: string;
  farmId?: string;
  currentStep: ApplicationSteps;
  roundRobinStatus: RoundRobinStatus;
  status: ApplicationStatus;
  installer: SolarInstallerDetails;
  address: string;
  lat: number;
  lng: number;
  establishedCostOfPowerPerKWh: number;
  estimatedKWhGeneratedPerYear: number;
  contactType?: ContactType;
  contactValue?: string;
  farm?: any; // Farm still wip
  documentsMissingWithReason?: DocumentMissingWithReason[];
  annotations?: GCAStepAnnotation[];
  documents?: ApplicationDocument[];
  deferments?: Deferment[];
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
  paymentDate?: string;
  gcaAssignedTimestamp?: string;
  gcaAcceptanceTimestamp?: string;
  gcaAdress?: string;
  createdAt: string;
  updatedAt: string;
};
