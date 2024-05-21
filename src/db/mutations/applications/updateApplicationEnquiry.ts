import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationUpdateEnquiryType,
  Documents,
  DocumentsInsertType,
  applications,
} from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  EncryptedMasterKeySet,
} from "../../../types/api-types/Application";

export const updateApplicationEnquiry = async (
  applicationId: string,
  latestUtilityBillPublicUrl: string,
  keysSet: EncryptedMasterKeySet[],
  insertValues: ApplicationUpdateEnquiryType
) => {
  return await db.transaction(async (tx) => {
    const updateRes = await db
      .update(applications)
      .set({
        ...insertValues,
        status: ApplicationStatusEnum.waitingForApproval,
      })
      .where(eq(applications.id, applicationId))
      .returning({ id: applications.id });

    if (updateRes.length === 0) {
      tx.rollback();
    }

    const documents: DocumentsInsertType[] = [
      {
        name: "Latest Utility Bill",
        applicationId,
        url: latestUtilityBillPublicUrl,
        type: "enc",
        annotation: null,
        step: ApplicationSteps.enquiry,
        encryptedMasterKeys: keysSet,
        createdAt: new Date(),
      },
    ];

    const documentInsert = await tx
      .insert(Documents)
      .values(documents)
      .returning({ id: Documents.id });

    if (documentInsert.length !== documents.length) {
      tx.rollback();
    }
  });
};
