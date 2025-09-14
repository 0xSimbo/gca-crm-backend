import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, applications } from "../../schema";
import { requirementSetMap } from "../../zones";

export const findAllApplicationsByOrganizationIds = async (
  organizationIds: string[]
) => {
  if (organizationIds.length === 0) {
    return [];
  }
  const applicationsDb = await db.query.OrganizationApplications.findMany({
    where: and(
      inArray(OrganizationApplications.organizationId, organizationIds)
    ),
    columns: {},
    with: {
      application: {
        columns: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          currentStep: true,
          roundRobinStatus: true,
          gcaAddress: true,
          allowedZones: true,
          isCancelled: true,
          revisedKwhGeneratedPerYear: true,
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
        },
      },
    },
  });
  return applicationsDb.map(
    ({ application: { enquiryFieldsCRS, ...application } }) => ({
      ...application,
      ...enquiryFieldsCRS,
    })
  );
};
