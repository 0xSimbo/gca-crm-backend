import { and, count, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationStepApprovals,
  DeviceInsertType,
  Devices,
  Documents,
  DocumentsInsertType,
  applications,
  farms,
} from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../../types/api-types/Application";

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

  return db.transaction(async (tx) => {
    if (documents.length) {
      const documentsInsert = await tx
        .insert(Documents)
        .values(documents)
        .returning({ id: Documents.id });

      if (documentsInsert.length !== documents.length) {
        tx.rollback();
      }
    }

    const applicationUpdateStatus = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.completed,
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

    const farmInsert = await tx
      .insert(farms)
      .values({
        gcaId: gcaId,
        userId: userId,
        createdAt: new Date(),
        auditCompleteDate: new Date(), //TODO: check if this is correct
      })
      .returning({ farmId: applications.farmId });

    //TODO: patch rewardsSplits with the new farmId

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
  });
};
