import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { formatUnits } from "viem";
import { requirementSetCodes, requirementSetMap } from "../../zones";
import { getZoneRequirementFields } from "./zoneRequirementsUtil";

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

  return {
    ...applicationDb,
    finalProtocolFee: formatUnits(
      (applicationDb?.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
    enquiryFields: applicationDb.enquiryFieldsCRS,
    auditFields: applicationDb.auditFieldsCRS,
  };
};
