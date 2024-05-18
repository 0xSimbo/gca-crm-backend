import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { AccountType } from "../../db/schema";
import { ApplicationStatusEnum } from "../../types/api-types/Application";

export const approveOrAskForChangesCheckHandler = async (
  stepIndex: number,
  applicationId: string,
  deadline: number,
  account: AccountType
): Promise<{ errorCode: number; errorMessage: string } | null> => {
  if (account.role !== "GCA") {
    return { errorCode: 403, errorMessage: "Unauthorized" };
  }

  if (deadline < Date.now() / 1000) {
    return { errorCode: 403, errorMessage: "Deadline has passed" };
  }

  // deadline max 10minutes
  if (deadline > Date.now() / 1000 + 600) {
    return {
      errorCode: 403,
      errorMessage: "Deadline is too far in the future",
    };
  }

  const application = await FindFirstApplicationById(applicationId);

  if (!application) {
    return { errorCode: 404, errorMessage: "Application not found" };
  }

  if (application.status !== ApplicationStatusEnum.waitingForApproval) {
    return {
      errorCode: 403,
      errorMessage: "Application is not in waitingForApproval status",
    };
  }

  if (application.currentStep !== stepIndex) {
    return { errorCode: 403, errorMessage: "Invalid step index" };
  }
  return null;
};
