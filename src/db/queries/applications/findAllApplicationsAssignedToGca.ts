import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsAssignedToGca = async (gcaAddress: string) => {
  const applicationsDb = await db.query.applications.findMany({
    where: and(
      eq(applications.gcaAddress, gcaAddress),
      eq(applications.isCancelled, false)
    ),
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      address: true,
      currentStep: true,
      roundRobinStatus: true,
      gcaAddress: true,
      isCancelled: true,
      installerCompanyName: true,
      installerEmail: true,
      installerPhone: true,
      installerName: true,
      farmOwnerName: true,
      farmOwnerEmail: true,
      farmOwnerPhone: true,
      preInstallVisitDate: true,
      afterInstallVisitDate: true,
    },
    with: {
      user: {
        columns: {
          contactType: true,
          contactValue: true,
        },
      },
    },
  });
  return applicationsDb;
};
