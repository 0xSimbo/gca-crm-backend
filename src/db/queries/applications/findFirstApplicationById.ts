import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { formatUnits } from "viem";

export const FindFirstApplicationById = async (id: string) => {
  const applicationDb = await db.query.applications.findFirst({
    where: eq(applications.id, id),
    with: {
      gca: true,
      enquiryFieldsCRS: true,
      auditFieldsCRS: true,
      zone: {
        with: {
          requirementSet: true,
        },
      },
      user: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          contactType: true,
          contactValue: true,
        },
      },
      organizationApplication: {
        columns: {
          organizationId: true,
          id: true,
        },
      },
      documentsMissingWithReason: true,
      applicationStepApprovals: true,
      rewardSplits: true,
      devices: true,
      weeklyProduction: true,
      weeklyCarbonDebt: true,
    },
  });

  if (!applicationDb) {
    return null;
  }

  const {
    enquiryFieldsCRS,
    auditFieldsCRS,
    zone,
    rewardSplits,
    ...application
  } = applicationDb;

  return {
    ...application,
    finalProtocolFee: formatUnits(
      (application?.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
    finalProtocolFeeBigInt: application.finalProtocolFee.toString(),
    auditFees: application.auditFees.toString(),
    enquiryFields: enquiryFieldsCRS,
    auditFields: auditFieldsCRS,
    zone: zone,
    rewardSplits: rewardSplits,
  };
};

export const FindFirstApplicationByIdMinimal = async (id: string) => {
  const applicationDb = await db.query.applications.findFirst({
    where: eq(applications.id, id),
    with: {
      gca: {
        columns: {
          id: true,
        },
      },
      applicationPriceQuotes: true,
      user: {
        columns: {
          id: true,
        },
      },
      zone: {
        with: {
          requirementSet: true,
        },
      },
    },
  });

  if (!applicationDb) {
    return null;
  }

  const { zone, ...application } = applicationDb;

  return {
    ...application,
    finalProtocolFee: application.finalProtocolFee.toString(),
    auditFees: application.auditFees.toString(),
    zone: zone,
  };
};
