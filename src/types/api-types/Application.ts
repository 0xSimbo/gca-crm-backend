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
  "waiting-for-payment",
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
  waitingForPayment = "waiting-for-payment",
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

export const optionalDocuments = [
  "plansets",
  "city permit",
  "inspection",
  "pto",
] as const;

export enum OptionalDocumentsEnum {
  plansets = "plansets",
  cityPermit = "city permit",
  inspection = "inspection",
  pto = "pto",
}

export enum RequiredDocumentsNamesEnum {
  contractAgreement = "required_contract_agreement",
  latestUtilityBill = "required_latest_utility_bill",
  declarationOfIntention = "required_declaration_of_intention",
  firstUtilityBill = "required_first_utility_bill",
  secondUtilityBill = "required_second_utility_bill",
  mortgageStatement = "required_mortgage_statement",
  propertyDeed = "required_property_deed",
  finalAuditReport = "required_final_audit_report",
}

export enum OptionalDocumentsNamesEnum {
  plansets = "misc_plansets",
  cityPermit = "misc_city_permit",
  inspection = "misc_inspection",
  pto = "misc_pto",
}

export type OptionalDocument = (typeof optionalDocuments)[number];

export const splitTokens = ["USDG", "GLOW"] as const;
