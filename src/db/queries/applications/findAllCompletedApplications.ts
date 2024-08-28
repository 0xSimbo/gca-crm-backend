import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents, applications } from "../../schema";
import { formatUnits } from "viem";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

export const findAllCompletedApplications = async (withDocuments?: boolean) => {
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
      paymentDate: true,
      lat: true,
      lng: true,
      gcaAddress: true,
      finalProtocolFee: true,
      userId: true,
      gcaAcceptanceTimestamp: true,
      gcaAssignedTimestamp: true,
      solarPanelsQuantity: true,
      solarPanelsBrandAndModel: true,
      solarPanelsWarranty: true,
      averageSunlightHoursPerDay: true,
      finalEnergyCost: true,
      systemWattageOutput: true,
      adjustedWeeklyCarbonCredits: true,
      weeklyTotalCarbonDebt: true,
      netCarbonCreditEarningWeekly: true,
      revisedCostOfPowerPerKWh: true,
      estimatedCostOfPowerPerKWh: true,
      revisedKwhGeneratedPerYear: true,
      installFinishedDate: true,
      ptoObtainedDate: true,
      revisedInstallFinishedDate: true,
      locationWithoutPII: true,
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
          isEnabled: true,
          enabledAt: true,
          disabledAt: true,
        },
      },
      documents: {
        where: eq(Documents.isEncrypted, false),
        columns: withDocuments
          ? {
              id: true,
              name: true,
              url: true,
              annotation: true,
              createdAt: true,
            }
          : { id: true },
      },
    },
  });
  return applicationsDb
    .map((application) => ({
      ...application,
      finalProtocolFee: formatUnits(
        (application.finalProtocolFee || BigInt(0)) as bigint,
        6
      ),
    }))
    .sort(
      (a, b) =>
        b.farm!!.auditCompleteDate.getTime() -
        a.farm!!.auditCompleteDate.getTime()
    )
    .reverse();
};
