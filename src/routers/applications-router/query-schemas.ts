import { t } from "elysia";

export const WeeklyProductionSchema = {
  powerOutputMWH: t.Numeric({ minimum: 0 }),
  hoursOfSunlightPerDay: t.Numeric({ minimum: 0 }),
  carbonOffsetsPerMWH: t.Numeric({ minimum: 0 }),
  adjustmentDueToUncertainty: t.Numeric({ minimum: 0, maximum: 1 }),
  weeklyPowerProductionMWh: t.Numeric({ minimum: 0 }),
  weeklyCarbonCredits: t.Numeric({ minimum: 0 }),
  adjustedWeeklyCarbonCredits: t.Numeric({ minimum: 0 }),
};

export const WeeklyCarbonDebtSchema = {
  totalCarbonDebtAdjustedKWh: t.Numeric({ minimum: 0 }),
  convertToKW: t.Numeric({ minimum: 0 }),
  totalCarbonDebtProduced: t.Numeric({ minimum: 0 }),
  disasterRisk: t.Numeric({ minimum: 0, maximum: 1 }),
  commitmentPeriod: t.Numeric({ minimum: 1 }),
  adjustedTotalCarbonDebt: t.Numeric({ minimum: 0 }),
  weeklyTotalCarbonDebt: t.Numeric({ minimum: 0 }),
};

// --- Moved from applicationsRouter.ts ---

export const encryptedFileUpload = t.Object({
  publicUrl: t.String({
    example:
      "https://pub-7e0365747f054c9e85051df5f20fa815.r2.dev/0x18a0ba01bbec4aa358650d297ba7bb330a78b073/utility-bill.enc",
  }),
});

export interface EncryptedFileUploadType {
  publicUrl: string;
}

export interface ApplicationEncryptedMasterKeysType {
  userId: string;
  encryptedMasterKey: string;
  organizationUserId?: string;
}

export const EnquiryQueryBody = t.Object({
  applicationId: t.String(),
  latestUtilityBill: encryptedFileUpload,
  declarationOfIntentionBody: t.Optional(
    t.Object({
      declarationOfIntention: encryptedFileUpload,
      declarationOfIntentionSignature: t.String(),
      declarationOfIntentionFieldsValue: t.Object({
        fullname: t.String(),
        latitude: t.String(),
        longitude: t.String(),
        date: t.Number(),
      }),
      declarationOfIntentionVersion: t.String(),
    })
  ),
  organizationIds: t.Array(t.String()),
  applicationEncryptedMasterKeys: t.Array(
    t.Object({
      userId: t.String(),
      encryptedMasterKey: t.String(),
      organizationUserId: t.Optional(t.String()),
    })
  ),
  estimatedCostOfPowerPerKWh: t.Numeric({
    example: 0.12,
    minimum: 0,
  }),
  enquiryEstimatedFees: t.Numeric({
    example: 109894,
    minimum: 0,
  }),
  enquiryEstimatedQuotePerWatt: t.Numeric({
    example: 0.32,
    minimum: 0,
  }),
  estimatedKWhGeneratedPerYear: t.Numeric({
    example: 32,
    minimum: 0,
  }),
  farmOwnerName: t.String({
    example: "John Doe",
    minLength: 2,
  }),
  farmOwnerEmail: t.String({
    example: "JohnDoe@gmail.com",
    minLength: 2,
  }),
  farmOwnerPhone: t.String({
    example: "123-456-7890",
    minLength: 2,
  }),
  installerCompanyName: t.String({
    example: "John Doe Farms",
    minLength: 2,
  }),
  installerEmail: t.String({
    example: "JohnDoe@gmail.com",
    minLength: 2,
  }),
  installerPhone: t.String({
    example: "123-456-7890",
    minLength: 2,
  }),
  installerName: t.String({
    example: "John",
    minLength: 2,
  }),
  address: t.String({
    example: "123 John Doe Street, Phoenix, AZ 85001",
    minLength: 10,
  }),
  lat: t.Numeric({
    example: 38.234242,
    minimum: -90,
    maximum: 90,
  }),
  lng: t.Numeric({
    example: -111.123412,
    minimum: -180,
    maximum: 180,
  }),
  zoneId: t.Number(),
});

export const DeclarationOfIntentionMissingQueryBody = t.Object({
  applicationId: t.String(),
  declarationOfIntention: encryptedFileUpload,
  declarationOfIntentionSignature: t.String(),
  declarationOfIntentionFieldsValue: t.Object({
    fullname: t.String(),
    latitude: t.String(),
    longitude: t.String(),
    date: t.Number(),
  }),
  declarationOfIntentionVersion: t.String(),
});

export const PreInstallDocumentsQueryBody = t.Object({
  applicationId: t.String(),
  estimatedInstallDate: t.Date(),
  contractAgreement: encryptedFileUpload,
});

export const PermitDocumentationQueryBody = t.Object({
  applicationId: t.String(),
  estimatedInstallDate: t.Date(),
});

export const InspectionAndPTOQueryBody = t.Object({
  applicationId: t.String(),
  plansets: t.Nullable(encryptedFileUpload),
  plansetsNotAvailableReason: t.Nullable(t.String()),
  cityPermit: t.Nullable(encryptedFileUpload),
  cityPermitNotAvailableReason: t.Nullable(t.String()),
  inspection: t.Nullable(encryptedFileUpload),
  inspectionNotAvailableReason: t.Nullable(t.String()),
  pto: t.Nullable(encryptedFileUpload),
  firstUtilityBill: encryptedFileUpload,
  secondUtilityBill: encryptedFileUpload,
  mortgageStatement: t.Nullable(encryptedFileUpload),
  propertyDeed: t.Nullable(encryptedFileUpload),
  ptoNotAvailableReason: t.Nullable(t.String()),
  installFinishedDate: t.Date(),
  miscDocuments: t.Array(
    t.Object({
      name: t.String(),
      encryptedFileUpload,
      extension: t.Union([
        t.Literal("pdf"),
        t.Literal("png"),
        t.Literal("jpg"),
        t.Literal("jpeg"),
      ]),
    })
  ),
});

export const GcaAcceptApplicationQueryBody = t.Object({
  applicationId: t.String(),
  signature: t.String(),
  deadline: t.Numeric(),
  accepted: t.Boolean(),
  reason: t.Nullable(t.String()),
  to: t.Nullable(
    t.String({
      example: "0x18a0bA01Bbec4aa358650d297Ba7bB330a78B073",
      minLength: 42,
      maxLength: 42,
    })
  ),
});

export const ApproveOrAskForChangesQueryBody = {
  applicationId: t.String(),
  signature: t.String(),
  deadline: t.Numeric(),
  approved: t.Boolean(),
  annotation: t.Nullable(t.String()),
  stepIndex: t.Numeric(),
};
