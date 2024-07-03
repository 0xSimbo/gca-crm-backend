import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";
import { ApplicationSteps } from "../../../types/api-types/Application";

export const findAllDocumentsByStep = async (
  step: ApplicationSteps,
  applicationId: string
) => {
  const documentsDb = await db.query.Documents.findMany({
    where: and(
      eq(Documents.step, step),
      eq(Documents.applicationId, applicationId)
    ),
    columns: {
      id: true,
      type: true,
      url: true,
      annotation: true,
      applicationId: true,
      createdAt: true,
      name: true,
      step: true,
      isEncrypted: true,
      isOverWritten: true,
      encryptedMasterKeys: true,
    },
    orderBy: desc(Documents.id),
  });
  return documentsDb;
};
