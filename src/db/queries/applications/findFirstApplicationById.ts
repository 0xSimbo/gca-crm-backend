import { eq } from "drizzle-orm";
import { db } from "../../db";
import { ApplicationType, applications } from "../../schema";
import { formatUnits } from "viem";

export const FindFirstApplicationById = async (id: string) => {
  const applicationDb = await db.query.applications.findFirst({
    where: eq(applications.id, id),
    with: {
      gca: true,
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
      documentsMissingWithReason: true,
      applicationStepApprovals: true,
      rewardSplits: true,
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
  };
};
