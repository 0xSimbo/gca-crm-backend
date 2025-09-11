import { and, eq, gte, isNotNull, not } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../../types/api-types/Application";

function stringifyApplicationFields(
  application: any,
  zone: any,
  enquiryFieldsCRS?: any
) {
  return {
    ...application,
    zone,
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

export const findAllAuditFeesPaidApplicationsByZoneId = async (
  zoneId?: number
) => {
  const whereConditions = [
    eq(applications.isCancelled, false),
    isNotNull(applications.auditFeesTxHash),
    not(eq(applications.status, ApplicationStatusEnum.completed)),
    gte(applications.currentStep, ApplicationSteps.preInstallDocuments),
  ];

  if (zoneId !== undefined) {
    whereConditions.push(eq(applications.zoneId, zoneId));
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
      auditFees: true,
      auditFeesTxHash: true,
      maxSplits: true,
    },
    with: {
      zone: {
        columns: {
          id: true,
          name: true,
        },
      },
      farm: {
        columns: {
          id: true,
        },
      },
      enquiryFieldsCRS: {
        columns: {
          lat: true,
          lng: true,
        },
      },
    },
  });

  return applicationsDb
    .map(({ enquiryFieldsCRS, zone, ...application }) =>
      stringifyApplicationFields(application, zone, enquiryFieldsCRS)
    )
    .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
};
