import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, applications } from "../../schema";
import { formatUnits } from "viem";

export const findAllApplicationsByOrganizationId = async (
  organizationId: string
) => {
  const applicationsDb = await db.query.OrganizationApplications.findMany({
    where: and(eq(OrganizationApplications.organizationId, organizationId)),
    columns: {
      id: true,
    },
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
          farmOwnerName: true,
          isCancelled: true,
          farmOwnerEmail: true,
          farmOwnerPhone: true,
          finalProtocolFee: true,
          preInstallVisitDate: true,
          afterInstallVisitDate: true,
        },
        with: {
          user: {
            columns: {
              id: true,
              contactType: true,
              contactValue: true,
            },
          },
        },
      },
    },
  });
  return applicationsDb.map(({ id, application }) => ({
    ...application,
    organizationApplicationId: id,
    finalProtocolFee: formatUnits(
      (application.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
  }));
};
