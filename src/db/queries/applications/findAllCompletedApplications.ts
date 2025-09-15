import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  Documents,
  applications,
  fractions,
  fractionSplits,
  type FractionType,
  type FractionSplitType,
  type ZoneType,
  type ApplicationEnquiryFieldsCRSInsertType,
  type ApplicationAuditFieldsCRSInsertType,
} from "../../schema";
import { formatUnits } from "viem";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";
import { FRACTION_STATUS } from "../../../constants/fractions";

type SponsorWallet = {
  walletAddress: string;
  fractions: number; // Actually represents steps purchased, kept as 'fractions' for API compatibility
};

type StringifiedApplicationResult = {
  finalProtocolFee: string;
  finalProtocolFeeBigInt: string;
  paymentAmount: string;
  auditFees: string;
  maxSplits: string;
  sponsorWallets?: SponsorWallet[];
  sponsorSplitPercent?: number;
  [key: string]: any;
};

function stringifyApplicationFields(
  application: any, // Keep flexible for now since query structure varies
  zone: any,
  enquiryFieldsCRS?: any,
  auditFieldsCRS?: any
): StringifiedApplicationResult {
  // Find the filled fraction (there should only be one)
  const filledFraction = application.fractions?.find(
    (fraction: any) =>
      fraction.isFilled && fraction.status === FRACTION_STATUS.FILLED
  );

  // Aggregate sponsor wallets ONLY from filled fractions
  const sponsorWallets: SponsorWallet[] = [];
  let sponsorSplitPercent: number | undefined;

  if (filledFraction) {
    // Get the sponsor split percentage from the filled fraction
    sponsorSplitPercent = filledFraction.sponsorSplitPercent;

    // Count steps purchased by each wallet from the filled fraction's splits
    if (filledFraction.splits && filledFraction.splits.length > 0) {
      const walletMap = new Map<string, number>();

      filledFraction.splits.forEach((split: FractionSplitType) => {
        const currentCount = walletMap.get(split.buyer) || 0;
        // Use stepsPurchased instead of just counting transactions
        const stepsPurchased = split.stepsPurchased || 1; // Fallback to 1 for backward compatibility
        walletMap.set(split.buyer, currentCount + stepsPurchased);
      });

      // Convert map to array format
      walletMap.forEach((stepsCount, walletAddress) => {
        sponsorWallets.push({ walletAddress, fractions: stepsCount });
      });

      // Sort by number of steps purchased (descending)
      sponsorWallets.sort((a, b) => b.fractions - a.fractions);
    }
  }
  // Helper function to safely convert to bigint
  const toBigInt = (
    value: bigint | string | null | undefined,
    defaultValue: bigint = BigInt(0)
  ): bigint => {
    if (value === undefined || value === null) return defaultValue;
    return typeof value === "string" ? BigInt(value) : value;
  };

  const finalProtocolFeeBigInt = toBigInt(application.finalProtocolFee);
  const paymentAmountBigInt = toBigInt(application.paymentAmount);
  const auditFeesBigInt = toBigInt(application.auditFees);
  const maxSplitsBigInt = toBigInt(application.maxSplits);

  return {
    ...application,
    finalProtocolFee: formatUnits(finalProtocolFeeBigInt, 6),
    finalProtocolFeeBigInt: finalProtocolFeeBigInt.toString(),
    paymentAmount: paymentAmountBigInt.toString(),
    auditFees: auditFeesBigInt.toString(),
    maxSplits: maxSplitsBigInt.toString(),
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
    sponsorSplitPercent,
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
              stepsPurchased: true,
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
      paymentAmount: true,
      paymentCurrency: true,
      paymentEventType: true,
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
              stepsPurchased: true,
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
