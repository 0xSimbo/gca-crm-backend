import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findAllApplicationsWithoutMasterKey = async () => {
  const applicationsDb = await db.query.applications.findMany({
    columns: {
      id: true,
    },
    with: {
      enquiryFieldsCRS: {
        columns: {
          farmOwnerName: true,
        },
      },
      applicationsEncryptedMasterKeys: {
        columns: {
          id: true,
        },
      },
      user: {
        columns: {
          id: true,
          publicEncryptionKey: true,
        },
      },
      documents: {
        where: eq(Documents.isEncrypted, true),
      },
    },
  });
  return applicationsDb
    .filter(
      (application) => application.applicationsEncryptedMasterKeys.length === 0
    )
    .map((application) => ({
      ...application,
      ...application.enquiryFieldsCRS,
    }));
};
