import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";
import { requirementSetMap } from "../../zones";

export const findAllApplicationsWithoutMasterKey = async () => {
  const applicationsDb = await db.query.applications.findMany({
    columns: {
      id: true,
    },
    with: {
      enquiryFieldsCRS: {
        columns: requirementSetMap.CRS.enquiryColumnsSelect,
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
    .map(({ enquiryFieldsCRS, ...application }) => ({
      ...application,
      ...enquiryFieldsCRS,
    }));
};
