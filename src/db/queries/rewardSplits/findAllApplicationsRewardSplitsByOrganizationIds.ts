import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationApplications } from "../../schema";
import { ApplicationStatusEnum } from "../../../types/api-types/Application";
import { requirementSetMap } from "../../zones";

export const findAllApplicationsRewardSplitsByOrganizationIds = async (
  organizationIds: string[]
) => {
  if (organizationIds.length === 0) {
    return [];
  }
  const applicationsDb = await db.query.OrganizationApplications.findMany({
    where: and(
      inArray(OrganizationApplications.organizationId, organizationIds)
    ),
    columns: {},
    with: {
      application: {
        columns: {
          id: true,
          status: true,
          isCancelled: true,
        },
        with: {
          enquiryFieldsCRS: {
            columns: requirementSetMap.CRS.enquiryColumnsSelect,
          },
          zone: {
            with: {
              requirementSet: true,
            },
          },
          rewardSplits: true,
        },
      },
    },
  });
  return applicationsDb
    .map(({ application, application: { enquiryFieldsCRS } }) => ({
      ...application,
      enquiryFields: enquiryFieldsCRS,
      zone: application.zone,
    }))
    .filter(
      (a) => a.status === ApplicationStatusEnum.completed && !a.isCancelled
    )
    .flat();
};
