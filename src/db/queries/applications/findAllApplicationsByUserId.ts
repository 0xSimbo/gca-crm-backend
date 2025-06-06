import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsByUserId = async (userId: string) => {
  const applicationsDb = await db.query.applications.findMany({
    where: eq(applications.userId, userId),
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,

      currentStep: true,
      roundRobinStatus: true,
      gcaAddress: true,

      isCancelled: true,
      preInstallVisitDate: true,
      afterInstallVisitDate: true,
    },
    with: {
      enquiryFieldsCRS: {
        columns: {
          address: true,
          installerCompanyName: true,
          installerEmail: true,
          installerPhone: true,
          installerName: true,
          farmOwnerName: true,
          farmOwnerEmail: true,
          farmOwnerPhone: true,
        },
      },
      user: {
        columns: {
          contactType: true,
          contactValue: true,
        },
      },
    },
  });
  return applicationsDb.map((application) => ({
    ...application,
    ...application.enquiryFieldsCRS,
  }));
};
