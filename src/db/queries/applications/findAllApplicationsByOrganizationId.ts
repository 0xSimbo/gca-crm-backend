import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications } from "../../schema";
import { formatUnits } from "viem";
import { requirementSetMap } from "../../zones";

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
          allowedZones: true,
          currentStep: true,
          roundRobinStatus: true,
          gcaAddress: true,
          auditFees: true,
          auditFeesTxHash: true,
          isCancelled: true,
          revisedKwhGeneratedPerYear: true,
          finalProtocolFee: true,
          preInstallVisitDate: true,
          afterInstallVisitDate: true,
          sponsorSplitPercent: true,
          isPublishedOnAuction: true,
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
              id: true,
              contactType: true,
              contactValue: true,
            },
          },
          weeklyCarbonDebt: true,
          weeklyProduction: true,
        },
      },
    },
  });
  return applicationsDb.map(
    ({
      id,
      application: { enquiryFieldsCRS, auditFieldsCRS, zone, ...application },
    }) => ({
      ...application,
      organizationApplicationId: id,
      finalProtocolFee: formatUnits(
        (application.finalProtocolFee || BigInt(0)) as bigint,
        6
      ),
      auditFees: application.auditFees?.toString() || "0",
      finalProtocolFeeBigInt: application.finalProtocolFee.toString(),
      enquiryFields: enquiryFieldsCRS,
      auditFields: auditFieldsCRS,
      zone: zone,
    })
  );
};
