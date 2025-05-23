import { db } from "../../db";
import {
  ApplicationSteps,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { Documents, applications } from "../../schema";
import { eq } from "drizzle-orm";
import { EncryptedFileUploadType } from "../../../routers/applications-router/query-schemas";
import { declarationOfIntentionFieldsValueType } from "./createApplication";

export const patchDeclarationOfIntention = async (
  applicationId: string,
  declarationOfIntention: EncryptedFileUploadType,
  declarationOfIntentionSignature: string,
  declarationOfIntentionFieldsValue: declarationOfIntentionFieldsValueType,
  declarationOfIntentionVersion: string
) => {
  return await db.transaction(async (tx) => {
    // Create document record for declaration of intention
    const document = await tx
      .insert(Documents)
      .values({
        name: RequiredDocumentsNamesEnum.declarationOfIntention,
        applicationId: applicationId,
        url: declarationOfIntention.publicUrl,
        type: "pdf",
        isEncrypted: true,
        annotation: null,
        step: ApplicationSteps.enquiry,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      })
      .returning({ id: Documents.id });

    if (document.length === 0) {
      tx.rollback();
      throw new Error("Failed to create declaration of intention document");
    }

    // Update application with declaration details
    const updatedApplication = await tx
      .update(applications)
      .set({
        declarationOfIntentionSignature: declarationOfIntentionSignature,
        declarationOfIntentionFieldsValue: declarationOfIntentionFieldsValue,
        declarationOfIntentionVersion: declarationOfIntentionVersion,
        declarationOfIntentionSignatureDate: new Date(
          declarationOfIntentionFieldsValue.date * 1000
        ),
      })
      .where(eq(applications.id, applicationId))
      .returning({ id: applications.id });

    if (updatedApplication.length === 0) {
      tx.rollback();
      throw new Error(
        "Failed to update application with declaration of intention"
      );
    }

    return updatedApplication[0].id;
  });
};
