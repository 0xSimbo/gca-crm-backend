import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
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
  isPublishedOnAuction?: boolean
) => {
  const whereConditions = [
    eq(applications.isCancelled, false),
    eq(applications.status, ApplicationStatusEnum.waitingForPayment),
  ];

  if (isPublishedOnAuction !== undefined) {
    whereConditions.push(
      eq(applications.isPublishedOnAuction, isPublishedOnAuction)
    );
  }

  const applicationsDb = await db.query.applications.findMany({
    where: and(...whereConditions),
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
      isPublishedOnAuction: true,
      publishedOnAuctionTimestamp: true,
      finalProtocolFee: true,
      auditFees: true,
      allowedZones: true,
    },
    with: {
      zone: {
        columns: {
          id: true,
          name: true,
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
