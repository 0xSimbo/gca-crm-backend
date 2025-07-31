import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { requirementSetMap } from "../../zones";

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
      revisedKwhGeneratedPerYear: true,
      isCancelled: true,
      preInstallVisitDate: true,
      afterInstallVisitDate: true,
    },
    with: {
      enquiryFieldsCRS: {
        columns: requirementSetMap.CRS.enquiryColumnsSelect,
      },
      user: {
        columns: {
          contactType: true,
          contactValue: true,
        },
      },
      auditFieldsCRS: true,
      zone: {
        with: {
          requirementSet: true,
        },
      },
      weeklyCarbonDebt: true,
      weeklyProduction: true,
    },
  });
  return applicationsDb.map((application) => ({
    ...application,
    enquiryFields: application.enquiryFieldsCRS,
    auditFields: application.auditFieldsCRS,
    zone: application.zone,
  }));
};
