import { db } from "../../db";
import { requirementSetMap } from "../../zones";

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
        columns: requirementSetMap.CRS.enquiryColumnsSelect,
      },
      auditFieldsCRS: true,
      zone: {
        with: {
          requirementSet: true,
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
  return applicationsDb.map(
    ({ enquiryFieldsCRS, auditFieldsCRS, zone, ...application }) => ({
      ...application,
      enquiryFields: enquiryFieldsCRS,
      auditFields: auditFieldsCRS,
      zone: zone,
    })
  );
};
