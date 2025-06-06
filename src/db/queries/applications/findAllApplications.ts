import { db } from "../../db";

export const findAllApplications = async () => {
  const applicationsDb = await db.query.applications.findMany({
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,

      currentStep: true,
      roundRobinStatus: true,
      gcaAddress: true,
      isCancelled: true,
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
    enquiryFields: application.enquiryFieldsCRS,
  }));
};
