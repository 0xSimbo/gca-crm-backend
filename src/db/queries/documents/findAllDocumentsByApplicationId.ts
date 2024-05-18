import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findAllDocumentsByApplicationId = async (
  applicationId: string
) => {
  const documentsDb = await db.query.Documents.findMany({
    where: eq(Documents.applicationId, applicationId),
    columns: {
      type: true,
      url: true,
      annotation: true,
      applicationId: true,
      createdAt: true,
      name: true,
      step: true,
    },
  });
  return documentsDb;
};
