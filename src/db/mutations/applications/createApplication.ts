import { ApplicationSteps } from "../../../types/api-types/Application";
import { db } from "../../db";
import {
  ApplicationInsertType,
  Documents,
  DocumentsInsertType,
  applications,
} from "../../schema";

export const createApplication = async (
  latestUtilityBillPresignedUrl: string,
  application: ApplicationInsertType
) => {
  const insertedId = await db.transaction(async (tx) => {
    const res = await db
      .insert(applications)
      .values(application)
      .returning({ insertedId: applications.id });
    if (res.length === 0) {
      tx.rollback();
    }
    const resInsertedId = res[0].insertedId;

    const documents: DocumentsInsertType[] = [
      {
        name: "Latest Utility Bill",
        applicationId: resInsertedId,
        url: latestUtilityBillPresignedUrl,
        type: "enc",
        annotation: null,
        step: ApplicationSteps.enquiry,
        encryptedMasterKeys: [],
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

    return resInsertedId;
  });
  return insertedId;
};
