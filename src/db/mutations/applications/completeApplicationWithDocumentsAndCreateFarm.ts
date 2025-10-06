import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  Devices,
  Documents,
  RewardSplits,
  applications,
  farms,
} from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../../types/api-types/Application";
import { createAndUploadJsonFile } from "../../../utils/r2/upload-to-r2";

import { getRegionFromLatAndLng } from "../../../utils/getRegionFromLatAndLng";

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
 * @param protocolFee - The protocol fee.
 * @param protocolFeeAdditionalPaymentTxHash - The additional payment tx hash.
 * @param protocolFeePaymentHash - The payment tx hash.
 * @param paymentDate - The date of the payment.
 * @param lat - The latitude of the farm.
 * @param lng - The longitude of the farm.
 * @param farmName - The name of the farm.
 */
export const completeApplicationWithDocumentsAndCreateFarmWithDevices = async ({
  applicationId,
  gcaId,
  userId,
  devices,
  protocolFee,
  protocolFeeAdditionalPaymentTxHash,
  protocolFeePaymentHash,
  paymentDate,
  lat,
  lng,
  farmName,
  paymentCurrency,
  paymentEventType,
  paymentAmount,
  zoneId,
}: {
  applicationId: string;
  gcaId: string;
  userId: string;
  devices: { publicKey: string; shortId: string }[];
  protocolFee: bigint;
  protocolFeeAdditionalPaymentTxHash: string | null;
  protocolFeePaymentHash: string;
  paymentDate: Date;
  lat: string;
  lng: string;
  farmName: string;
  paymentCurrency: string;
  paymentEventType: string;
  paymentAmount: string;
  zoneId: number;
}) => {
  if (!process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME) {
    throw new Error("R2_NOT_ENCRYPTED_FILES_BUCKET_NAME is not defined");
  }

  if (devices.length === 0) {
    throw new Error("No devices provided");
  }

  const uploadsArr = [
    createAndUploadJsonFile(
      process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
      `${applicationId}/payment_receipt.json`,
      {
        protocolFee: protocolFee.toString(),
        protocolFeePaymentHash,
        protocolFeeAdditionalPaymentTxHash,
        applicationId,
        paymentCurrency,
        paymentEventType,
      }
    ),
  ];

  const uploads = await Promise.all(uploadsArr);

  const insertDocuments = [
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

  // get region from lat and lng and store in newly created farm
  const region = await getRegionFromLatAndLng(lat, lng);

  return db.transaction(async (tx) => {
    await tx
      .insert(Documents)
      .values(insertDocuments)
      .returning({ id: Documents.id });

    const farmInsert = await tx
      .insert(farms)
      .values({
        gcaId: gcaId,
        userId: userId,
        createdAt: new Date(),
        auditCompleteDate: new Date(),
        protocolFee,
        protocolFeePaymentHash,
        protocolFeeAdditionalPaymentTxHash,
        region: region.region,
        regionFullName: region.regionFullName,
        signalType: region.signalType,
        name: farmName,
        zoneId: zoneId,
      })
      .returning({ farmId: applications.farmId });

    await tx
      .insert(Devices)
      .values(
        devices.map((device) => ({
          ...device,
          farmId: farmInsert[0].farmId!!,
        }))
      )
      .returning({ id: Devices.id });

    await tx
      .update(RewardSplits)
      .set({ farmId: farmInsert[0].farmId })
      .where(eq(RewardSplits.applicationId, applicationId))
      .returning({ farmId: RewardSplits.farmId });

    await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.completed,
        paymentDate,
        paymentTxHash: protocolFeePaymentHash,
        paymentCurrency,
        paymentEventType,
        paymentAmount,
        farmId: farmInsert[0].farmId,
      })
      .where(and(eq(applications.id, applicationId)))
      .returning({ status: applications.status });

    return farmInsert[0].farmId as string;
  });
};
