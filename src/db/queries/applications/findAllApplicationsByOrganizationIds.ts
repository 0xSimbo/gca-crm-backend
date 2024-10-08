import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, applications } from "../../schema";

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
          address: true,
          currentStep: true,
          roundRobinStatus: true,
          gcaAddress: true,
          installerCompanyName: true,
          installerEmail: true,
          installerPhone: true,
          installerName: true,
          isCancelled: true,
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
      },
    },
  });
  return applicationsDb.map((application) => application.application);
};
