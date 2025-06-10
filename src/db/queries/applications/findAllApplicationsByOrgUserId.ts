import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications, applications } from "../../schema";
import { formatUnits } from "viem";
import { requirementSetMap } from "../../zones";

export const findAllApplicationsByOrgUserId = async (
  organizationUserId: string
) => {
  const applicationsDb = await db.query.OrganizationApplications.findMany({
    where: eq(OrganizationApplications.orgUserId, organizationUserId),
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

          currentStep: true,
          roundRobinStatus: true,
          gcaAddress: true,

          isCancelled: true,
          finalProtocolFee: true,
          preInstallVisitDate: true,
          afterInstallVisitDate: true,
        },
        with: {
          enquiryFieldsCRS: {
            columns: requirementSetMap.CRS.enquiryColumnsSelect,
          },
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
  return applicationsDb.map(
    ({ id, application: { enquiryFieldsCRS, ...application } }) => ({
      ...application,
      organizationApplicationId: id,
      finalProtocolFee: formatUnits(
        (application.finalProtocolFee || BigInt(0)) as bigint,
        6
      ),
      ...enquiryFieldsCRS,
    })
  );
};
