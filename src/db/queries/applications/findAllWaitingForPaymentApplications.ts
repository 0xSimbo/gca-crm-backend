import { and, eq, exists, inArray, gt } from "drizzle-orm";
import { db } from "../../db";
import { applications, fractions } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";

function stringifyApplicationFields(
  application: any,
  zone: any,
  enquiryFieldsCRS?: any
) {
  return {
    ...application,
    zone,
    finalProtocolFee: application.finalProtocolFee.toString(),
    auditFees: application.auditFees?.toString() || "0",
    maxSplits: application.maxSplits?.toString() || "0",
    lat:
      enquiryFieldsCRS?.lat !== undefined && enquiryFieldsCRS?.lat !== null
        ? enquiryFieldsCRS.lat.toString()
        : undefined,
    lng:
      enquiryFieldsCRS?.lng !== undefined && enquiryFieldsCRS?.lng !== null
        ? enquiryFieldsCRS.lng.toString()
        : undefined,
  };
}

export const findAllWaitingForPaymentApplications = async (
  hasActiveFraction?: boolean
) => {
  let whereConditions = and(
    eq(applications.isCancelled, false),
    eq(applications.status, ApplicationStatusEnum.waitingForPayment)
  );

  if (hasActiveFraction !== undefined) {
    if (hasActiveFraction) {
      // Filter for applications that have active fractions
      whereConditions = and(
        whereConditions,
        exists(
          db
            .select()
            .from(fractions)
            .where(
              and(
                eq(fractions.applicationId, applications.id),
                eq(fractions.isFilled, false),
                eq(fractions.isCommittedOnChain, true),
                gt(fractions.expirationAt, new Date())
              )
            )
        )
      );
    } else {
      // Filter for applications that don't have active fractions (this case might be rare now)
      whereConditions = and(
        whereConditions
        // No active fractions exist for this application
        // This is a bit complex to express in SQL, so we might handle this in JS if needed
      );
    }
  }

  const applicationsDb = await db.query.applications.findMany({
    where: whereConditions,
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      gcaAddress: true,
      userId: true,
      gcaAcceptanceTimestamp: true,
      gcaAssignedTimestamp: true,
      installFinishedDate: true,
      finalProtocolFee: true,
      auditFees: true,
      auditFeesTxHash: true,
      maxSplits: true,
      allowedZones: true,
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
      enquiryFieldsCRS: {
        columns: {
          lat: true,
          lng: true,
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
      weeklyCarbonDebt: true,
      weeklyProduction: true,
    },
  });

  return applicationsDb
    .map(({ enquiryFieldsCRS, zone, ...application }) =>
      stringifyApplicationFields(application, zone, enquiryFieldsCRS)
    )
    .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
};
