import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationUpdateEnquiryType,
  Documents,
  applications,
  applicationsEnquiryFieldsCRS,
} from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { EncryptedFileUploadType } from "../../../routers/applications-router/query-schemas";
import { DocumentsInsertTypeExtended } from "./fillApplicationStepWithDocuments";

export const updateApplicationEnquiry = async (
  applicationId: string,
  latestUtilityBill: EncryptedFileUploadType,
  insertValues: ApplicationUpdateEnquiryType
) => {
  let documentId: string = "";
  await db.transaction(async (tx) => {
    const updateRes = await tx
      .update(applications)
      .set({
        status: ApplicationStatusEnum.waitingForApproval,
      })
      .where(eq(applications.id, applicationId))
      .returning({ id: applications.id });

    if (updateRes.length === 0) {
      tx.rollback();
    }

    await tx
      .update(applicationsEnquiryFieldsCRS)
      .set({
        ...insertValues,
      })
      .where(eq(applicationsEnquiryFieldsCRS.applicationId, applicationId));

    // console.log("updateRes", updateRes);

    const documents: DocumentsInsertTypeExtended[] = [
      {
        name: RequiredDocumentsNamesEnum.latestUtilityBill,
        applicationId,
        url: latestUtilityBill.publicUrl,
        type: "enc",
        annotation: null,
        isEncrypted: true,
        step: ApplicationSteps.enquiry,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      },
    ];

    const deleteAllDocuments = await tx
      .delete(Documents)
      .where(eq(Documents.applicationId, applicationId))
      .returning({ id: Documents.id });

    if (deleteAllDocuments.length === 0) {
      tx.rollback();
    }

    const documentInsert = await tx
      .insert(Documents)
      .values(documents)
      .returning({ id: Documents.id });

    if (documentInsert.length !== documents.length) {
      tx.rollback();
    }

    documentId = documentInsert[0].id;
  });
};
