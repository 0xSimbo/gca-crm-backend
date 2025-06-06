import { findFirstOrganizationApplicationByApplicationId } from "../../db/queries/applications/findFirstOrganizationApplicationByApplicationId";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { ApplicationType } from "../../db/schema";
import {
  ApplicationStatus,
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";
import { PermissionsEnum } from "../../types/api-types/Permissions";

export const fillApplicationStepCheckHandler = async (
  userId: string,
  application: {
    userId: string;
    status: ApplicationStatus;
    currentStep: ApplicationSteps;
  },
  applicationStep: ApplicationSteps
): Promise<{ errorCode: number; errorMessage: string } | null> => {
  if (application.userId !== userId) {
    //TODO: Uncomment this after figuring out edit application encryption
    // const organizationApplication =
    //   await findFirstOrganizationApplicationByApplicationId(application.id);
    // if (!organizationApplication) {
    return {
      errorCode: 403,
      errorMessage: "Only the application owner can perform this action",
    };
    // }
    // const organizationMember = await findOrganizationMemberByUserId(
    //   organizationApplication.organization.id,
    //   userId
    // );
    // if (!organizationMember) {
    //   return {
    //     errorCode: 403,
    //     errorMessage:
    //       "Only the application owner or organization member can perform this action",
    //   };
    // }

    // if (
    //   !organizationMember.role.rolePermissions.find(
    //     (p) => p.permission.key === PermissionsEnum.ApplicationsEdit
    //   )
    // ) {
    //   return {
    //     errorCode: 403,
    //     errorMessage: "User does not have the required permissions",
    //   };
    // }
  }

  if (
    application.status !== ApplicationStatusEnum.draft &&
    application.status !== ApplicationStatusEnum.changesRequired
  ) {
    return {
      errorCode: 403,
      errorMessage: "Application is not in the correct status to make changes",
    };
  }
  if (application.currentStep !== applicationStep) {
    return {
      errorCode: 403,
      errorMessage: "Application is not in the correct step to make changes",
    };
  }
  return null;
};
