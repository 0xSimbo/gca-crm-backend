import { and, count, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationStepApprovals,
  DeviceInsertType,
  Devices,
  Documents,
  DocumentsInsertType,
  RewardSplits,
  applications,
  deferments,
  farms,
} from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../../types/api-types/Application";
import {
  createAndUploadJsonFile,
  createAndUploadTXTFile,
} from "../../../utils/r2/upload-to-r2";
import { getStepNameFromIndex } from "../../../utils/getStepNameFromIndex";

export type ApplicationAuditFieldsType = {
  solarPanelsQuantity: number;
  solarPanelsBrandAndModel: string;
  solarPanelsWarranty: string;
  averageSunlightHoursPerDay: string;
  finalEnergyCost: string;
  adjustedWeeklyCarbonCredits: string;
  weeklyTotalCarbonDebt: string;
  netCarbonCreditEarningWeekly: string;
  ptoObtainedDate: Date | null;
  revisedInstallFinishedDate: Date;
  locationWithoutPII: string;
};

/**
 * Fills an application step with documents atomically.
 *
 * @param applicationId - The ID of the application.
 * @param gcaId - The ID of the GCA.
 * @param userId - The ID of the user.
 * @param signature - The signature of the GCA.
 * @param status - The status of the application.
 * @param documents - The documents to insert.
 * @param devices - An array of devices to create and link to the farm.
 */
export const completeApplicationWithDocumentsAndCreateFarmWithDevices = async (
  applicationId: string,
  gcaId: string,
  userId: string,
  signature: string,
  documents: DocumentsInsertType[],
  devices: { publicKey: string; shortId: string }[],
  protocolFee: bigint,
  protocolFeePaymentHash: string,
  applicationAuditFields: ApplicationAuditFieldsType
) => {
  if (!process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME) {
    throw new Error("R2_NOT_ENCRYPTED_FILES_BUCKET_NAME is not defined");
  }

  if (devices.length === 0) {
    throw new Error("No devices provided");
  }

  if (documents.length === 0) {
    throw new Error("No documents provided");
  }

  const applicationEncryptedDocuments = await db.query.Documents.findMany({
    where: and(
      eq(Documents.applicationId, applicationId),
      eq(Documents.isEncrypted, true),
      isNotNull(Documents.annotation)
    ),
  });

  const applicationDeferments = await db.query.deferments.findMany({
    where: eq(deferments.applicationId, applicationId),
  });

  const applicationStepApprovals =
    await db.query.ApplicationStepApprovals.findMany({
      where: and(
        eq(ApplicationStepApprovals.applicationId, applicationId),
        isNotNull(ApplicationStepApprovals.annotation)
      ),
    });

  const annotationsTxtPromises = applicationEncryptedDocuments.map((doc) =>
    createAndUploadTXTFile(
      process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
      `${applicationId}/${doc.name}_annotations.txt`,
      doc.annotation || ""
    )
  );

  // const encryptionKeysTxtPromises = applicationEncryptedDocuments.map((doc) =>
  //   createAndUploadJsonFile(
  //     process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
  //     `${applicationId}/${doc.name}_encryption_keys.json`,
  //     doc.encryptedMasterKeys
  //   )
  // );
  let defermentsTxtPromises: Promise<string> | undefined;
  if (applicationDeferments.length) {
    defermentsTxtPromises = createAndUploadJsonFile(
      process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
      `${applicationId}/deferments.json`,
      applicationDeferments
    );
  }

  const extraThoughtsTxtPromises = applicationStepApprovals.map((approval) =>
    createAndUploadTXTFile(
      process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
      `${applicationId}/${getStepNameFromIndex(
        approval.step
      )}_extra_thoughts.txt`,
      approval.annotation || ""
    )
  );

  const uploadsArr = [
    ...annotationsTxtPromises,
    // ...encryptionKeysTxtPromises,
    ...extraThoughtsTxtPromises,
  ];

  if (defermentsTxtPromises) {
    uploadsArr.push(defermentsTxtPromises);
  }

  const uploads = await Promise.all(uploadsArr);

  const insertDocuments = [
    ...documents,
    ...uploads.map((publicUrl) => ({
      name: publicUrl.split(`${applicationId}/`)[1].split(".")[0],
      applicationId: applicationId,
      url: publicUrl,
      type: publicUrl.endsWith(".txt") ? "txt" : "json",
      isEncrypted: false,
      annotation: null,
      step: ApplicationSteps.payment,
      encryptedMasterKeys: [],
      createdAt: new Date(),
    })),
  ];

  return db.transaction(async (tx) => {
    if (documents.length) {
      const documentsInsert = await tx
        .insert(Documents)
        .values(insertDocuments)
        .returning({ id: Documents.id });

      if (documentsInsert.length !== insertDocuments.length) {
        tx.rollback();
      }
    }

    const farmInsert = await tx
      .insert(farms)
      .values({
        gcaId: gcaId,
        userId: userId,
        createdAt: new Date(),
        auditCompleteDate: new Date(),
        protocolFee,
        protocolFeePaymentHash,
      })
      .returning({ farmId: applications.farmId });

    if (!farmInsert[0].farmId || farmInsert[0].farmId === null) {
      tx.rollback();
    }

    const devicesInsert = await tx
      .insert(Devices)
      .values(
        devices.map((device) => ({
          ...device,
          farmId: farmInsert[0].farmId!!,
        }))
      )
      .returning({ id: Devices.id });

    if (devicesInsert.length !== devices.length) {
      tx.rollback();
    }

    const rewardSplitsUpdate = await tx
      .update(RewardSplits)
      .set({ farmId: farmInsert[0].farmId })
      .where(eq(RewardSplits.applicationId, applicationId))
      .returning({ farmId: RewardSplits.farmId });

    if (
      !rewardSplitsUpdate.every(({ farmId }) => farmId === farmInsert[0].farmId)
    ) {
      tx.rollback();
    }

    const applicationUpdateStatus = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.completed,
        farmId: farmInsert[0].farmId,
        ...applicationAuditFields,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });

    if (
      !applicationUpdateStatus.every(
        ({ status }) => status === ApplicationStatusEnum.completed
      )
    ) {
      tx.rollback();
    }

    const approval = await tx
      .insert(ApplicationStepApprovals)
      .values({
        applicationId: applicationId,
        gcaAddress: gcaId,
        step: ApplicationSteps.payment,
        approvedAt: new Date(),
        signature,
      })
      .returning({ id: ApplicationStepApprovals.id });

    if (!approval[0].id) {
      tx.rollback();
    }
  });
};
