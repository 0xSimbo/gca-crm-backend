import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents, applications } from "../../schema";
import { formatUnits } from "viem";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const findAllCompletedApplications = async () => {
  const applicationsDb = await db.query.applications.findMany({
    where: and(
      eq(applications.isCancelled, false),
      eq(applications.status, ApplicationStatusEnum.completed)
    ),
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      paymentTxHash: true,
      lat: true,
      lng: true,
      gcaAddress: true,
      finalProtocolFee: true,
      userId: true,
      gcaAcceptanceTimestamp: true,
      gcaAssignedTimestamp: true,
    },
    with: {
      rewardSplits: {
        columns: {
          id: true,
          walletAddress: true,
          glowSplitPercent: true,
          usdgSplitPercent: true,
        },
      },
      farm: {
        columns: {
          id: true,
          auditCompleteDate: true,
        },
      },
      devices: {
        columns: {
          publicKey: true,
          shortId: true,
        },
      },
    },
  });
  return applicationsDb.map((application) => ({
    ...application,
    finalProtocolFee: formatUnits(
      (application.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
  }));
};
