import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { requirementSetMap } from "../../zones";

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

      currentStep: true,
      roundRobinStatus: true,
      gcaAddress: true,
      isCancelled: true,

      preInstallVisitDate: true,
      afterInstallVisitDate: true,
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
      weeklyCarbonDebt: true,
      weeklyProduction: true,
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
