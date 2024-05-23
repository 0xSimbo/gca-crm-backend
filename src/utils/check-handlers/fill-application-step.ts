import { ApplicationType } from "../../db/schema";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";

export const fillApplicationStepCheckHandler = async (
  userId: string,
  application: ApplicationType,
  applicationStep: ApplicationSteps
): Promise<{ errorCode: number; errorMessage: string } | null> => {
  if (application.userId !== userId) {
    return {
      errorCode: 403,
      errorMessage: "Only the application owner can perform this action",
    };
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
