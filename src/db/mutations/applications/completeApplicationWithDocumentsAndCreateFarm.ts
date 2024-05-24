import { and, count, eq, isNotNull } from "drizzle-orm";
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
  devices: { publicKey: string; shortId: string }[]
) => {
  if (devices.length === 0) {
    throw new Error("No devices provided");
  }

  if (documents.length === 0) {
    throw new Error("No documents provided");
  }

  const applicationEncryptedDocuments = await db.query.Documents.findMany({
    where: and(
      eq(Documents.applicationId, applicationId),
      eq(Documents.isEncrypted, true)
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

  // sync with @0xSimbo for misc_doc_name_rationale.txt ?? do we need to upload the missing documents with reason ?
  const annotationsTxtPromises = applicationEncryptedDocuments.map((doc) =>
    createAndUploadTXTFile(
      "gca-crm-public",
      `${applicationId}/${doc.name}_annotations.txt`,
      doc.annotation || ""
    )
  );

  const encryptionKeysTxtPromises = applicationEncryptedDocuments.map((doc) =>
    createAndUploadJsonFile(
      "gca-crm-public",
      `${applicationId}/${doc.name}_encryption_keys.json`,
      doc.encryptedMasterKeys
    )
  );

  const defermentsTxtPromises = createAndUploadJsonFile(
    "gca-crm-public",
    `${applicationId}/deferments.json`,
    applicationDeferments
  );

  const extraThoughtsTxtPromises = applicationStepApprovals.map((approval) =>
    createAndUploadTXTFile(
      "gca-crm-public",
      `${applicationId}/${getStepNameFromIndex(
        approval.step
      )}_extra_thoughts.txt`,
      approval.annotation || ""
    )
  );

  const uploads = await Promise.all([
    ...annotationsTxtPromises,
    ...encryptionKeysTxtPromises,
    defermentsTxtPromises,
    ...extraThoughtsTxtPromises,
  ]);

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
        auditCompleteDate: new Date(), //TODO: check if this is correct
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
      .where(and(eq(RewardSplits.id, applicationId)))
      .returning({ farmId: applications.farmId });

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
