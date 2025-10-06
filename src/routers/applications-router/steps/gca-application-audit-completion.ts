import {
  ApplicationAuditFieldsType,
  completeApplicationAudit,
} from "../../../db/mutations/applications/completeApplicationAudit";
import { ApplicationType, DocumentsInsertType } from "../../../db/schema";
import {
  ApplicationSteps,
  OptionalDocumentsNamesEnum,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { listObjects } from "../../../utils/r2/upload-to-r2";
import { getUniqueStarNameForApplicationId } from "../../farms/farmsRouter";
import { completeApplicationWithDocumentsAndCreateFarmWithDevices } from "../../../db/mutations/applications/completeApplicationWithDocumentsAndCreateFarm";
import { getProtocolFeePaymentFromTxHashReceipt } from "../../../utils/getProtocolFeePaymentFromTxHashReceipt";
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

export const handleCreateWithoutPIIDocumentsAndCompleteApplicationAudit =
  async (
    application: ApplicationType,
    gcaId: string,
    signature: string,
    canonicalPricesJson: string,
    step: ApplicationSteps,
    stepAnnotation: string | null,
    args: WithoutPiiDocumentsType & {
      finalAuditReport: string;
      devices: { publicKey: string; shortId: string }[];
      miscDocuments: {
        publicUrl: string;
        documentName: string;
        extension: string;
        isShowingSolarPanels: boolean;
      }[];
      applicationAuditFields: ApplicationAuditFieldsType;
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
    ];

    if (!application.enquiryFields) {
      throw new Error("Enquiry fields are missing");
    }

    if (args.mortgageStatement) {
      documents.push({
        name: RequiredDocumentsNamesEnum.mortgageStatement,
        applicationId: application.id,
        url: args.mortgageStatement,
        type: "pdf",
        annotation: null,
        step,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      });
    }

    if (args.propertyDeed) {
      documents.push({
        name: RequiredDocumentsNamesEnum.propertyDeed,
        applicationId: application.id,
        url: args.propertyDeed,
        type: "pdf",
        annotation: null,
        step,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      });
    }

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
          isShowingSolarPanels: misc.isShowingSolarPanels,
        }))
      );
    }

    const formatKey = (key: string) =>
      key
        .replace(/\(\d+\)/, "")
        .replace(/\.[^/.]+$/, "")
        .trim();

    const allRequiredKeys = documents.map((doc) => formatKey(doc.name));
    const appId = application.id;

    const objects = await listObjects(
      process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
      appId
    );

    if (!objects || objects.length === 0) {
      return { message: "Files not uploaded to r2" };
    }

    // Create a map to count occurrences of each required key
    const requiredKeyCounts = new Map<string, number>();
    allRequiredKeys.forEach((key) => {
      const formattedKey = formatKey(key);
      requiredKeyCounts.set(
        formattedKey,
        (requiredKeyCounts.get(formattedKey) || 0) + 1
      );
    });

    objects.forEach((object) => {
      const key = object.Key;
      if (!key) {
        return;
      }

      // Extract the base name without the suffix and trim spaces
      const baseKey = formatKey(key.split(appId)[1]);

      const requiredKey = allRequiredKeys.find((requiredKey) =>
        baseKey.includes(requiredKey)
      );

      if (requiredKey) {
        const count = requiredKeyCounts.get(requiredKey);

        if (count && count > 0) {
          requiredKeyCounts.set(requiredKey, count - 1);
          allRequiredKeys.splice(allRequiredKeys.indexOf(requiredKey), 1);
        }
      }
    });

    if (allRequiredKeys.length) {
      throw new Error("Some documents upload failed " + allRequiredKeys);
    }

    const farmName = await getUniqueStarNameForApplicationId(application.id);
    if (!farmName) {
      throw new Error("Failed to get a unique farm name");
    }

    let txData;
    if (application.paymentTxHash && application.paymentDate) {
      try {
        console.log("application.paymentTxHash", application.paymentTxHash);
        txData = await getProtocolFeePaymentFromTxHashReceipt(
          application.paymentTxHash
        );
        if (!txData) {
          console.error(
            "Failed to get protocol fee payment from tx hash receipt"
          );
          throw new Error(
            "Failed to get protocol fee payment from tx hash receipt"
          );
        }
      } catch (e) {
        console.error(
          "Failed to get protocol fee payment from tx hash receipt",
          e
        );
        throw new Error(
          "Failed to get protocol fee payment from tx hash receipt, " + e
        );
      }
    }
    console.log("completeApplicationAudit");
    await completeApplicationAudit(
      application.id,
      gcaId,
      signature,
      canonicalPricesJson,
      documents,
      args.devices,
      stepAnnotation,
      args.applicationAuditFields
    );
    if (txData && application.paymentTxHash && application.paymentDate) {
      await completeApplicationWithDocumentsAndCreateFarmWithDevices({
        protocolFeePaymentHash: application.paymentTxHash,
        paymentDate: application.paymentDate,
        paymentCurrency: application.paymentCurrency,
        paymentEventType: application.paymentEventType,
        paymentAmount: application.paymentAmount,
        applicationId: application.id,
        gcaId: application.gcaAddress!,
        userId: application.userId,
        devices: args.devices,
        protocolFee: BigInt(application.finalProtocolFeeBigInt),
        protocolFeeAdditionalPaymentTxHash: null,
        lat: application.enquiryFields?.lat,
        lng: application.enquiryFields?.lng,
        farmName: application.enquiryFields?.farmOwnerName,
        zoneId: application.zoneId,
      });
      console.log(
        "completeApplicationWithDocumentsAndCreateFarmWithDevices done"
      );
    }
  };
