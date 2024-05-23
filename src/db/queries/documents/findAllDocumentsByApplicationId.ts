import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findAllDocumentsByApplicationId = async (
  applicationId: string
) => {
  const documentsDb = await db.query.Documents.findMany({
    where: eq(Documents.applicationId, applicationId),
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
    },
    orderBy: asc(Documents.id),
  });
  return documentsDb;
};
