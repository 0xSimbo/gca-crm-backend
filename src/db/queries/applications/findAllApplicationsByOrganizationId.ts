import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, applications } from "../../schema";
import { formatUnits } from "viem";

export const findAllApplicationsByOrganizationId = async (
  organizationId: string
) => {
  const applicationsDb = await db.query.OrganizationApplications.findMany({
    where: eq(OrganizationApplications.organizationId, organizationId),
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
          farmOwnerName: true,
          finalProtocolFee: true,
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
  return applicationsDb.map(({ application }) => ({
    ...application,
    finalProtocolFee: formatUnits(
      (application.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
  }));
};