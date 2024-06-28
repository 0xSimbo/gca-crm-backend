import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findAllEncryptedDocumentsByApplicationsIds = async (
  applicationIds: string[]
) => {
  const documentsDb = await db.query.Documents.findMany({
    where: and(
      inArray(Documents.applicationId, applicationIds),
      eq(Documents.isEncrypted, true)
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
      encryptedMasterKeys: true,
    },
    with: {
      application: {
        columns: {},
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
