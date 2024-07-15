import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findAllEncryptedDocuments = async () => {
  const documentsDb = await db.query.Documents.findMany({
    where: and(eq(Documents.isEncrypted, true)),
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
    with: {
      application: {
        columns: {
          id: true,
        },
        with: {
          organizationApplication: {
            columns: {
              organizationId: true,
              id: true,
            },
          },
        },
      },
    },
    orderBy: desc(Documents.step),
  });
  return documentsDb;
};
