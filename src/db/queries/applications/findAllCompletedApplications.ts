import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  Documents,
  applications,
  fractions,
  fractionSplits,
} from "../../schema";
import { formatUnits } from "viem";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";
import { FRACTION_STATUS } from "../../../constants/fractions";

function stringifyApplicationFields(
  application: any,
  zone: any,
  enquiryFieldsCRS?: any,
  auditFieldsCRS?: any
) {
  // Aggregate sponsor wallets from fraction splits
  const sponsorWallets: Array<{ walletAddress: string; fractions: number }> =
    [];

  if (application.fractions && application.fractions.length > 0) {
    const walletMap = new Map<string, number>();

    application.fractions.forEach((fraction: any) => {
      if (fraction.splits && fraction.splits.length > 0) {
        fraction.splits.forEach((split: any) => {
          const currentCount = walletMap.get(split.buyer) || 0;
          walletMap.set(split.buyer, currentCount + 1);
        });
      }
    });

    // Convert map to array format
    walletMap.forEach((fractions, walletAddress) => {
      sponsorWallets.push({ walletAddress, fractions });
    });

    // Sort by number of fractions purchased (descending)
    sponsorWallets.sort((a, b) => b.fractions - a.fractions);
  }
  return {
    ...application,
    finalProtocolFee: formatUnits(
      (application.finalProtocolFee || BigInt(0)) as bigint,
      6
    ),
    finalProtocolFeeBigInt: application.finalProtocolFee.toString(),
    paymentAmount: application.paymentAmount.toString(),
    auditFees: application.auditFees?.toString() || "0",
    maxSplits: application.maxSplits?.toString() || "0",
    ...enquiryFieldsCRS,
    ...auditFieldsCRS,
    zone,
    lat:
      enquiryFieldsCRS?.lat !== undefined && enquiryFieldsCRS?.lat !== null
        ? enquiryFieldsCRS.lat.toString()
        : undefined,
    lng:
      enquiryFieldsCRS?.lng !== undefined && enquiryFieldsCRS?.lng !== null
        ? enquiryFieldsCRS.lng.toString()
        : undefined,
    estimatedCostOfPowerPerKWh:
      enquiryFieldsCRS?.estimatedCostOfPowerPerKWh !== undefined &&
      enquiryFieldsCRS?.estimatedCostOfPowerPerKWh !== null
        ? enquiryFieldsCRS.estimatedCostOfPowerPerKWh.toString()
        : undefined,
    averageSunlightHoursPerDay:
      auditFieldsCRS?.averageSunlightHoursPerDay !== undefined &&
      auditFieldsCRS?.averageSunlightHoursPerDay !== null
        ? auditFieldsCRS.averageSunlightHoursPerDay.toString()
        : undefined,
    finalEnergyCost:
      auditFieldsCRS?.finalEnergyCost !== undefined &&
      auditFieldsCRS?.finalEnergyCost !== null
        ? auditFieldsCRS.finalEnergyCost.toString()
        : undefined,
    adjustedWeeklyCarbonCredits:
      auditFieldsCRS?.adjustedWeeklyCarbonCredits !== undefined &&
      auditFieldsCRS?.adjustedWeeklyCarbonCredits !== null
        ? auditFieldsCRS.adjustedWeeklyCarbonCredits.toString()
        : undefined,
    weeklyTotalCarbonDebt:
      auditFieldsCRS?.weeklyTotalCarbonDebt !== undefined &&
      auditFieldsCRS?.weeklyTotalCarbonDebt !== null
        ? auditFieldsCRS.weeklyTotalCarbonDebt.toString()
        : undefined,
    netCarbonCreditEarningWeekly:
      auditFieldsCRS?.netCarbonCreditEarningWeekly !== undefined &&
      auditFieldsCRS?.netCarbonCreditEarningWeekly !== null
        ? auditFieldsCRS.netCarbonCreditEarningWeekly.toString()
        : undefined,
    sponsorWallets: sponsorWallets.length > 0 ? sponsorWallets : undefined,
  };
}

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
      additionalPaymentTxHash: true,
      paymentDate: true,
      revisedCostOfPowerPerKWh: true,
      gcaAddress: true,
      finalProtocolFee: true,
      auditFees: true,
      auditFeesTxHash: true,
      userId: true,
      gcaAcceptanceTimestamp: true,
      gcaAssignedTimestamp: true,
      installFinishedDate: true,
      revisedKwhGeneratedPerYear: true,
      isPublishedOnAuction: true,
      publishedOnAuctionTimestamp: true,
      sponsorSplitPercent: true,
      sponsorSplitUpdatedAt: true,
      paymentEventType: true,
      paymentCurrency: true,
      paymentAmount: true,
      payer: true,
    },
    with: {
      fractions: {
        where: eq(fractions.status, FRACTION_STATUS.FILLED),
        columns: {
          id: true,
          status: true,
          totalSteps: true,
          splitsSold: true,
        },
        with: {
          splits: {
            columns: {
              buyer: true,
              amount: true,
            },
          },
        },
      },
      zone: {
        columns: {
          id: true,
          name: true,
          isActive: true,
          isAcceptingSponsors: true,
        },
      },
      auditFieldsCRS: {
        columns: {
          solarPanelsQuantity: true,
          solarPanelsBrandAndModel: true,
          solarPanelsWarranty: true,
          averageSunlightHoursPerDay: true,
          finalEnergyCost: true,
          systemWattageOutput: true,
          adjustedWeeklyCarbonCredits: true,
          weeklyTotalCarbonDebt: true,
          netCarbonCreditEarningWeekly: true,
          ptoObtainedDate: true,
          revisedInstallFinishedDate: true,
          locationWithoutPII: true,
        },
      },
      enquiryFieldsCRS: {
        columns: {
          lat: true,
          lng: true,
          estimatedCostOfPowerPerKWh: true,
        },
      },
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
          name: true,
          region: true,
          regionFullName: true,
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
              isShowingSolarPanels: true,
            }
          : { id: true },
      },
    },
  });
  return applicationsDb
    .map(({ enquiryFieldsCRS, auditFieldsCRS, zone, ...application }) =>
      stringifyApplicationFields(
        application,
        zone,
        enquiryFieldsCRS,
        auditFieldsCRS
      )
    )
    .sort(
      (a, b) =>
        b.farm!!.auditCompleteDate.getTime() -
        a.farm!!.auditCompleteDate.getTime()
    )
    .reverse();
};

export const findCompletedApplication = async ({
  farmId,
  publicKey,
  shortId,
}: {
  farmId?: string;
  publicKey?: string;
  shortId?: string;
}) => {
  let whereClause;
  if (publicKey) {
    whereClause = (applications: any, { eq }: any) =>
      and(
        eq(applications.isCancelled, false),
        eq(applications.status, ApplicationStatusEnum.completed),
        eq(applications.devices.publicKey, publicKey)
      );
  } else if (shortId) {
    whereClause = (applications: any, { eq }: any) =>
      and(
        eq(applications.isCancelled, false),
        eq(applications.status, ApplicationStatusEnum.completed),
        eq(applications.devices.shortId, shortId)
      );
  } else if (farmId) {
    whereClause = (applications: any, { eq }: any) =>
      and(
        eq(applications.isCancelled, false),
        eq(applications.status, ApplicationStatusEnum.completed),
        eq(applications.farmId, farmId)
      );
  } else {
    throw new Error("You must provide one of: farmId, publicKey, or shortId");
  }

  const applicationsDb = await db.query.applications.findFirst({
    where: whereClause,
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      paymentTxHash: true,
      additionalPaymentTxHash: true,
      paymentDate: true,
      revisedCostOfPowerPerKWh: true,
      gcaAddress: true,
      finalProtocolFee: true,
      auditFees: true,
      auditFeesTxHash: true,
      userId: true,
      gcaAcceptanceTimestamp: true,
      gcaAssignedTimestamp: true,
      installFinishedDate: true,
      revisedKwhGeneratedPerYear: true,
      sponsorSplitPercent: true,
      isPublishedOnAuction: true,
      publishedOnAuctionTimestamp: true,
      sponsorSplitUpdatedAt: true,
      paymentAmount: true,
      paymentCurrency: true,
      paymentEventType: true,
      payer: true,
    },
    with: {
      zone: {
        columns: {
          id: true,
          name: true,
          isActive: true,
          isAcceptingSponsors: true,
        },
      },
      auditFieldsCRS: {
        columns: {
          solarPanelsQuantity: true,
          solarPanelsBrandAndModel: true,
          solarPanelsWarranty: true,
          averageSunlightHoursPerDay: true,
          finalEnergyCost: true,
          systemWattageOutput: true,
          adjustedWeeklyCarbonCredits: true,
          weeklyTotalCarbonDebt: true,
          netCarbonCreditEarningWeekly: true,
          ptoObtainedDate: true,
          revisedInstallFinishedDate: true,
          locationWithoutPII: true,
        },
      },
      enquiryFieldsCRS: {
        columns: {
          lat: true,
          lng: true,
          estimatedCostOfPowerPerKWh: true,
        },
      },
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
          region: true,
          regionFullName: true,
          signalType: true,
          name: true,
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
        columns: { id: true },
      },
    },
  });
  if (!applicationsDb) return undefined;
  const { enquiryFieldsCRS, auditFieldsCRS, zone, ...application } =
    applicationsDb;
  return stringifyApplicationFields(
    application,
    zone,
    enquiryFieldsCRS,
    auditFieldsCRS
  );
};
