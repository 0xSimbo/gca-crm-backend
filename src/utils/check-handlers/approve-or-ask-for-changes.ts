import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { AccountType, ApplicationType } from "../../db/schema";
import { ApplicationStatusEnum } from "../../types/api-types/Application";

export const approveOrAskForChangesCheckHandler = async (
  stepIndex: number,
  applicationId: string,
  deadline: number,
  account: AccountType
): Promise<{
  data: ApplicationType | null;
  errorCode: number;
  errorMessage: string;
}> => {
  if (account.role !== "GCA") {
    return { data: null, errorCode: 403, errorMessage: "Unauthorized" };
  }

  if (deadline < Date.now() / 1000) {
    return { data: null, errorCode: 403, errorMessage: "Deadline has passed" };
  }

  //TODO: uncomment when finished testing
  // deadline max 10minutes
  // if (deadline > Date.now() / 1000 + 600) {
  //   return {
  //     data: null,
  //     errorCode: 403,
  //     errorMessage: "Deadline is too far in the future",
  //   };
  // }

  const application = await FindFirstApplicationById(applicationId);

  if (!application) {
    return {
      data: null,
      errorCode: 404,
      errorMessage: "Application not found",
    };
  }

  if (
    application.status !== ApplicationStatusEnum.waitingForApproval &&
    application.status !== ApplicationStatusEnum.waitingForVisit &&
    application.status !== ApplicationStatusEnum.paymentConfirmed
  ) {
    return {
      data: null,
      errorCode: 403,
      errorMessage: "Application is not in the correct status",
    };
  }

  if (application.currentStep !== stepIndex) {
    return { data: null, errorCode: 403, errorMessage: "Invalid step index" };
  }
  return { data: application, errorCode: 200, errorMessage: "" };
};
