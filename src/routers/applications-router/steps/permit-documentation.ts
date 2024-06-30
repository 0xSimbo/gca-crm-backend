import { fillApplicationStepWithDocuments } from "../../../db/mutations/applications/fillApplicationStepWithDocuments";
import { ApplicationType } from "../../../db/schema";

export const handleCreateOrUpdatePermitDocumentation = async (
  application: ApplicationType,
  args: { estimatedInstallDate: Date }
) => {
  return await fillApplicationStepWithDocuments(
    undefined,
    application.id,
    application.status,
    application.currentStep,
    [],
    [],
    { estimatedInstallDate: args.estimatedInstallDate }
  );
};
