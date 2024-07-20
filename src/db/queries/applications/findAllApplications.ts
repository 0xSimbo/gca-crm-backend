import { db } from "../../db";

export const findAllApplications = async () => {
  const applicationsDb = await db.query.applications.findMany({
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
