import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { GetEntityByIdPathParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { createApplication } from "../../db/mutations/applications/createApplication";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  RoundRobinStatusEnum,
} from "../../types/api-types/Application";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { findAllApplicationsByUserId } from "../../db/queries/applications/findAllApplicationsByUserId";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllApplicationsAssignedToGca } from "../../db/queries/applications/findAllApplicationsAssignedToGca";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { acceptApplicationAssignement } from "../../db/mutations/applications/acceptApplicationAssignement";
import {
  applicationAcceptedTypes,
  deferredTypes,
} from "../../constants/typed-data/deferment";
import { deferApplicationAssignement } from "../../db/mutations/applications/deferApplicationAssignement";
import {
  applicationCompletedWithPaymentTypes,
  stepApprovedTypes,
  stepApprovedWithFinalProtocolFeeTypes,
} from "../../constants/typed-data/step-approval";
import { approveApplicationStep } from "../../db/mutations/applications/approveApplicationStep";
import { updateApplicationStatus } from "../../db/mutations/applications/updateApplicationStatus";
import { updateApplicationEnquiry } from "../../db/mutations/applications/updateApplicationEnquiry";
import { incrementApplicationStep } from "../../db/mutations/applications/incrementApplicationStep";
import { approveOrAskForChangesCheckHandler } from "../../utils/check-handlers/approve-or-ask-for-changes";
import { fillApplicationStepCheckHandler } from "../../utils/check-handlers/fill-application-step";
import { handleCreateOrUpdatePermitDocumentation } from "./steps/permit-documentation";
import { handleCreateOrUpdatePreIntallDocuments } from "./steps/pre-install";
import { updateApplicationPreInstallVisitDates } from "../../db/mutations/applications/updateApplicationPreInstallVisitDates";
import { updateApplicationAfterInstallVisitDates } from "../../db/mutations/applications/updateApplicationAfterInstallVisitDates";
import { handleCreateOrUpdateInspectionAndPto } from "./steps/inspection-and-pto";
import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { roundRobinAssignement } from "../../db/queries/gcas/roundRobinAssignement";
import {
  getProtocolFeePaymentFromTransactionHash,
  GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual,
} from "../../subgraph/queries/getProtocolFeePaymentFromTransactionHash";
import { ethers } from "ethers";
import { handleCreateWithoutPIIDocumentsAndCompleteApplication } from "./steps/gca-application-completion";

export const EnquiryQueryBody = t.Object({
  applicationId: t.Nullable(t.String()),
  latestUtilityBill: t.Object({
    publicUrl: t.String({
      example:
        "https://pub-7e0365747f054c9e85051df5f20fa815.r2.dev/0x18a0ba01bbec4aa358650d297ba7bb330a78b073/utility-bill.enc",
    }),
    keysSet: t.Array(
      t.Object({
        publicKey: t.String(),
        encryptedMasterKey: t.String(),
      })
    ),
  }),
  establishedCostOfPowerPerKWh: t.Numeric({
    example: 0.12,
    minimum: 0,
  }),
  enquiryEstimatedFees: t.Numeric({
    example: 109894,
    minimum: 0,
  }),
  enquiryEstimatedQuotePerWatt: t.Numeric({
    example: 0.32,
    minimum: 0,
  }),
  estimatedKWhGeneratedPerYear: t.Numeric({
    example: 32,
    minimum: 0,
  }),
  installerCompanyName: t.String({
    example: "John Doe Farms",
    minLength: 2,
  }),
  installerEmail: t.String({
    example: "JohnDoe@gmail.com",
    minLength: 2,
  }),
  installerPhone: t.String({
    example: "123-456-7890",
    minLength: 2,
  }),
  installerName: t.String({
    example: "John",
    minLength: 2,
  }),
  address: t.String({
    example: "123 John Doe Street, Phoenix, AZ 85001",
    minLength: 10,
  }),
  lat: t.Numeric({
    example: 38.234242,
    minimum: -90,
    maximum: 90,
  }),
  lng: t.Numeric({
    example: -111.123412,
    minimum: -180,
    maximum: 180,
  }),
});

// r2 baseUrl + bucketName = userID + fileName.enc @0xSimbo
const encryptedUploadedUrlExample =
  "https://pub-7e0365747f054c9e85051df5f20fa815.r2.dev/0x18a0ba01bbec4aa358650d297ba7bb330a78b073/contract-agreement.enc";
export const PreInstallDocumentsQueryBody = t.Object({
  applicationId: t.String(),
  contractAgreementPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
  plansetsPresignedUrl: t.Nullable(
    t.String({
      example: encryptedUploadedUrlExample,
    })
  ),
  plansetsNotAvailableReason: t.Nullable(t.String()),
  declarationOfIntentionPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
  firstUtilityBillPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
  secondUtilityBillPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
  mortgageStatementPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
  propertyDeedPresignedUrl: t.String({
    example: encryptedUploadedUrlExample,
  }),
});

export const PermitDocumentationQueryBody = t.Object({
  applicationId: t.String(),
  cityPermitPresignedUrl: t.Nullable(
    t.String({
      example: encryptedUploadedUrlExample,
    })
  ),
  cityPermitNotAvailableReason: t.Nullable(t.String()),
  estimatedInstallDate: t.Date(),
});

export const InspectionAndPTOQueryBody = t.Object({
  applicationId: t.String(),
  inspectionPresignedUrl: t.Nullable(
    t.String({
      example: encryptedUploadedUrlExample,
    })
  ),
  inspectionNotAvailableReason: t.Nullable(t.String()),
  ptoPresignedUrl: t.Nullable(
    t.String({
      example: encryptedUploadedUrlExample,
    })
  ),
  ptoNotAvailableReason: t.Nullable(t.String()),
  intallFinishedDate: t.Date(),
  miscDocuments: t.Array(
    t.Object({
      name: t.String(),
      presignedUrl: t.String(),
    })
  ),
});

export const GcaAcceptApplicationQueryBody = t.Object({
  applicationId: t.String(),
  signature: t.String(),
  deadline: t.Numeric(),
  accepted: t.Boolean(),
  reason: t.Nullable(t.String()),
  to: t.Nullable(
    t.String({
      example: "0x18a0bA01Bbec4aa358650d297Ba7bB330a78B073",
      minLength: 42,
      maxLength: 42,
    })
  ),
});

export const ApproveOrAskForChangesQueryBody = {
  applicationId: t.String(),
  signature: t.String(),
  deadline: t.Numeric(),
  approved: t.Boolean(),
  annotation: t.Nullable(t.String()),
  stepIndex: t.Numeric(),
};

export const applicationsRouter = new Elysia({ prefix: "/applications" })
  .use(bearerplugin())
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .get(
        "/byId",
        async ({ query, set, userId }) => {
          if (!query.id) throw new Error("ID is required");
          try {
            const application = await FindFirstApplicationById(query.id);
            if (!application) {
              set.status = 404;
              throw new Error("Application not found");
            }
            if (application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 403;
                return "Unauthorized";
              }
            }
            return application;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] byId", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Get Application by ID",
            description: `Get Application by ID`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/enquiry-approve-or-ask-for-changes",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            const errorChecks = await approveOrAskForChangesCheckHandler(
              body.stepIndex,
              body.applicationId,
              body.deadline,
              account
            );
            if (errorChecks.errorCode !== 200 || !errorChecks.data) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            const approvedValues = {
              applicationId: body.applicationId,
              approved: body.approved,
              deadline: body.deadline,
              stepIndex: body.stepIndex,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            const recoveredAddress = await recoverAddressHandler(
              stepApprovedTypes,
              approvedValues,
              body.signature,
              gcaId
            );

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            if (body.approved) {
              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature
              );
            } else {
              await updateApplicationStatus(
                body.applicationId,
                ApplicationStatusEnum.changesRequired
              );
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object(ApproveOrAskForChangesQueryBody),
          detail: {
            summary: "Gca Approve or Ask for Changes after step submission",
            description: `Approve or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/pre-install-documents-approve-or-ask-for-changes",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            const errorChecks = await approveOrAskForChangesCheckHandler(
              body.stepIndex,
              body.applicationId,
              body.deadline,
              account
            );
            if (errorChecks.errorCode !== 200 || !errorChecks.data) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            const approvedValues = {
              applicationId: body.applicationId,
              approved: body.approved,
              deadline: body.deadline,
              stepIndex: body.stepIndex,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            const recoveredAddress = await recoverAddressHandler(
              stepApprovedTypes,
              approvedValues,
              body.signature,
              gcaId
            );

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (!body.finalQuotePerWatt) {
                set.status = 400;
                return "finalQuotePerWatt is required";
              }
              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature,
                {
                  finalQuotePerWatt: body.finalQuotePerWatt,
                }
              );
            } else {
              await updateApplicationStatus(
                body.applicationId,
                ApplicationStatusEnum.changesRequired
              );
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            ...ApproveOrAskForChangesQueryBody,
            finalQuotePerWatt: t.Nullable(t.String()),
          }),
          detail: {
            summary: "Gca Approve or Ask for Changes after step submission",
            description: `Approve or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/gca-accept-or-defer-application-assignement",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);

            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.role !== "GCA") {
              set.status = 403;
              return "Unauthorized";
            }

            if (body.deadline < Date.now() / 1000) {
              set.status = 403;
              return "Deadline has passed";
            }

            // make deadline max 10minutes
            if (body.deadline > Date.now() / 1000 + 600) {
              set.status = 403;
              return "Deadline is too far in the future";
            }
            let recoveredAddress;
            if (body.accepted) {
              const acceptedValues = {
                applicationId: body.applicationId,
                accepted: body.accepted,
                deadline: body.deadline,
                // nonce is fetched from user account. nonce is updated for every new next-auth session
              };

              recoveredAddress = await recoverAddressHandler(
                applicationAcceptedTypes,
                acceptedValues,
                body.signature,
                gcaId
              );
              console.log("recoveredAddress", {
                recoveredAddress,
                acceptedValues,
              });
            } else {
              if (!body.to) {
                set.status = 400;
                return "to address is required for deferring application assignement";
              }
              const deferredValues = {
                applicationId: body.applicationId,
                accepted: body.accepted,
                deadline: body.deadline,
                to: body.to,
                // nonce is fetched from user account. nonce is updated for every new next-auth session
              };
              recoveredAddress = await recoverAddressHandler(
                deferredTypes,
                deferredValues,
                body.signature,
                gcaId
              );
            }

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (
              application.roundRobinStatus !==
              RoundRobinStatusEnum.waitingToBeAccepted
            ) {
              set.status = 403;
              return "Application is not in waitingToBeAccepted status";
            }

            if (body.accepted) {
              await acceptApplicationAssignement(
                body.applicationId,
                gcaId,
                body.signature
              );
            } else {
              if (!body.to) {
                set.status = 400;
                return "to address is required for deferring application assignement";
              }
              await deferApplicationAssignement(
                body.applicationId,
                account.id,
                body.to,
                body.reason,
                body.signature
              );
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: GcaAcceptApplicationQueryBody,
          detail: {
            summary: "Get Applications assigned to GCA",
            description: `Get Applications assigned to GCA. If the user is not a GCA, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/gca-assigned-applications",
        async ({ set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);

            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.role !== "GCA") {
              set.status = 403;
              return "Unauthorized";
            }

            const applications = await findAllApplicationsAssignedToGca(gcaId);
            // console.log("gca-assigned-applications", { applications, gcaId });
            return applications;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get Applications assigned to GCA",
            description: `Get Applications assigned to GCA. If the user is not a GCA, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/all-by-user-id",
        async ({ query: { id }, set, userId }) => {
          if (!id) throw new Error("userId is required");
          try {
            if (id !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 403;

                return "Unauthorized";
              }
            }
            const applications = await findAllApplicationsByUserId(id);
            // console.log(applications);
            return applications;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /all-by-user-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: GetEntityByIdPathParamsSchema,
          detail: {
            summary: "Get Applications by userId",
            description: `Get Applications by userId`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/enquiry",
        async ({ body, set, userId }) => {
          try {
            if (body.applicationId) {
              const application = await FindFirstApplicationById(
                body.applicationId
              );
              if (!application) {
                set.status = 404;
                return "Application not found";
              }
              const errorChecks = await fillApplicationStepCheckHandler(
                userId,
                application,
                ApplicationSteps.enquiry
              );

              if (errorChecks) {
                set.status = errorChecks.errorCode;
                return errorChecks.errorMessage;
              }

              const { applicationId, ...updateObject } = body;
              await updateApplicationEnquiry(
                body.applicationId,
                body.latestUtilityBill.publicUrl,
                body.latestUtilityBill.keysSet,
                {
                  ...updateObject,
                  establishedCostOfPowerPerKWh:
                    body.establishedCostOfPowerPerKWh.toString(),
                  enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                  enquiryEstimatedQuotePerWatt:
                    body.enquiryEstimatedQuotePerWatt.toString(),
                  estimatedKWhGeneratedPerYear:
                    body.estimatedKWhGeneratedPerYear.toString(),
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                }
              );
              return body.applicationId;
            }

            const gcaAddress = await roundRobinAssignement();
            const insertedId = await createApplication(
              body.latestUtilityBill.publicUrl,
              body.latestUtilityBill.keysSet,
              {
                userId,
                ...body,
                establishedCostOfPowerPerKWh:
                  body.establishedCostOfPowerPerKWh.toString(),
                estimatedKWhGeneratedPerYear:
                  body.estimatedKWhGeneratedPerYear.toString(),
                enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                enquiryEstimatedQuotePerWatt:
                  body.enquiryEstimatedQuotePerWatt.toString(),
                lat: body.lat.toString(),
                lng: body.lng.toString(),
                createdAt: new Date(),
                currentStep: 1,
                //TODO remove when @0xSimbo finished roundRobin implementation
                gcaAssignedTimestamp: new Date(),
                gcaAddress,
                roundRobinStatus: RoundRobinStatusEnum.waitingToBeAccepted,
                // roundRobinStatus: RoundRobinStatusEnum.waitingToBeAssigned,
                status: ApplicationStatusEnum.waitingForApproval,
              }
            );
            return { insertedId };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] enquiry", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: EnquiryQueryBody,
          detail: {
            summary: "Create or Update an Application",
            description: `Create an Application`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/pre-install-documents",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            const errorChecks = await fillApplicationStepCheckHandler(
              userId,
              application,
              ApplicationSteps.preInstallDocuments
            );

            if (errorChecks) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            if (
              body.plansetsNotAvailableReason &&
              body.plansetsPresignedUrl === null
            ) {
              await handleCreateOrUpdatePreIntallDocuments(
                application,
                ApplicationSteps.preInstallDocuments,
                {
                  ...body,
                  plansetsPresignedUrl: null,
                  plansetsNotAvailableReason: body.plansetsNotAvailableReason,
                }
              );
            } else if (
              body.plansetsNotAvailableReason === null &&
              body.plansetsPresignedUrl
            ) {
              await handleCreateOrUpdatePreIntallDocuments(
                application,
                ApplicationSteps.preInstallDocuments,
                {
                  ...body,
                  plansetsPresignedUrl: body.plansetsPresignedUrl,
                  plansetsNotAvailableReason: null,
                }
              );
            } else {
              set.status = 400;
              return "Either plansetsPresignedUrl or plansetsNotAvailableReason is required";
            }
            return body.applicationId;
          } catch (e) {
            console.error("error", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /pre-install-documents", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: PreInstallDocumentsQueryBody,
          detail: {
            summary: "Create or Update the pre-install documents",
            description: `insert the pre-install documents in db + insert documentsMissingWithReason if plansets missing and update the application status to waitingForApproval`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/permit-documentation",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            const errorChecks = await fillApplicationStepCheckHandler(
              userId,
              application,
              ApplicationSteps.permitDocumentation
            );

            if (errorChecks) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            if (
              body.cityPermitNotAvailableReason &&
              body.cityPermitPresignedUrl === null
            ) {
              await handleCreateOrUpdatePermitDocumentation(
                application,
                ApplicationSteps.permitDocumentation,
                {
                  cityPermitNotAvailableReason:
                    body.cityPermitNotAvailableReason,
                  cityPermitPresignedUrl: null,
                  estimatedInstallDate: body.estimatedInstallDate,
                }
              );
            } else if (
              body.cityPermitNotAvailableReason === null &&
              body.cityPermitPresignedUrl
            ) {
              await handleCreateOrUpdatePermitDocumentation(
                application,
                ApplicationSteps.permitDocumentation,
                {
                  cityPermitNotAvailableReason: null,
                  cityPermitPresignedUrl: body.cityPermitPresignedUrl,
                  estimatedInstallDate: body.estimatedInstallDate,
                }
              );
            } else {
              set.status = 400;
              return "Either cityPermitPresignedUrl or cityPermitNotAvailableReason is required";
            }
            return body.applicationId;
          } catch (e) {
            console.error("error", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /permit-documentation", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: PermitDocumentationQueryBody,
          detail: {
            summary: "Create or Update the permit documentation",
            description: `insert the permit documentation in db + insert documentsMissingWithReason if cityPermit missing and update the application status to waitingForApproval`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/inspection-and-pto",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            const errorChecks = await fillApplicationStepCheckHandler(
              userId,
              application,
              ApplicationSteps.inspectionAndPtoDocuments
            );

            if (errorChecks) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            if (
              !body.inspectionPresignedUrl &&
              !body.inspectionNotAvailableReason
            ) {
              set.status = 400;
              return "Either inspectionPresignedUrl or inspectionNotAvailableReason is required";
            }

            if (!body.ptoPresignedUrl && !body.ptoNotAvailableReason) {
              set.status = 400;
              return "Either ptoPresignedUrl or ptoNotAvailableReason is required";
            }

            await handleCreateOrUpdateInspectionAndPto(application, {
              inspectionNotAvailableReason: body.inspectionNotAvailableReason,
              inspectionPresignedUrl: body.inspectionPresignedUrl,
              ptoNotAvailableReason: body.ptoNotAvailableReason,
              ptoPresignedUrl: body.ptoPresignedUrl,
              intallFinishedDate: body.intallFinishedDate,
              miscDocuments: body.miscDocuments,
            });
            return body.applicationId;
          } catch (e) {
            console.error("error", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /permit-documentation", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: InspectionAndPTOQueryBody,
          detail: {
            summary: "Create or Update the Inspection and PTO documents",
            description: `insert the Inspection and PTO documents in db + insert documentsMissingWithReason if inspection or pto missing and update the application status to waitingForApproval`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/verify-payment",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application.userId !== userId) {
              set.status = 403;
              return "Unauthorized";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForPayment
            ) {
              set.status = 403;
              return "Application is not waiting for payment";
            }

            const protocolFeeData: GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual | null =
              await getProtocolFeePaymentFromTransactionHash(body.txHash);

            if (!protocolFeeData) {
              ///TODO: @JulienWebDeveloppeur this means the tx hash is not valid, we should return an error
            }

            /// @JulienWebDeveloppeur Here we need to check to make sure it's >= the amount we are expecting
            /// If it's greater, need to check with david what to do on that. For now, let's not change anything

            await updateApplication(body.applicationId, {
              status: ApplicationStatusEnum.paymentConfirmed,
              paymentTxHash: body.txHash,
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] verify-payment", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            txHash: t.String(),
          }),
          detail: {
            summary: "Increment the application step",
            description: `Increment the application step after user read the annotation left by the gca on the documents`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/next-step",
        async ({ query, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              query.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            if (application.userId !== userId) {
              set.status = 403;
              return "Unauthorized";
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 403;
              return "Application is not Approved";
            }
            await incrementApplicationStep(
              query.applicationId,
              application.currentStep
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] next-step", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Increment the application step",
            description: `Increment the application step after user read the annotation left by the gca on the documents`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/reject-final-quote-per-watt",
        async ({ query, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              query.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            if (application.userId !== userId) {
              set.status = 403;
              return "Unauthorized";
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 403;
              return "Application is not Approved";
            }
            if (
              application.currentStep !== ApplicationSteps.preInstallDocuments
            ) {
              set.status = 403;
              return "Action not authorized";
            }

            await updateApplicationStatus(
              query.applicationId,
              ApplicationStatusEnum.quoteRejected
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] reject-final-quote-per-watt", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Reject Final Quote Per Watt",
            description: `Update application status to quoteRejected after user rejected the final quote per watt`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/permit-documentation-approve-or-ask-for-changes",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            const errorChecks = await approveOrAskForChangesCheckHandler(
              body.stepIndex,
              body.applicationId,
              body.deadline,
              account
            );

            const application = errorChecks.data;

            if (errorChecks.errorCode !== 200 || !application) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            const approvedValues = {
              applicationId: body.applicationId,
              approved: body.approved,
              deadline: body.deadline,
              stepIndex: body.stepIndex,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            const recoveredAddress = await recoverAddressHandler(
              stepApprovedTypes,
              approvedValues,
              body.signature,
              gcaId
            );

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (
                !application.preInstallVisitDateFrom ||
                !application.preInstallVisitDateTo
              ) {
                set.status = 400;
                return "Pre Install Visit Dates are not set";
              }

              const now = new Date();
              const today = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate()
              );
              const preInstallVisitDateFromTime = new Date(
                application.preInstallVisitDateFrom.getFullYear(),
                application.preInstallVisitDateFrom.getMonth(),
                application.preInstallVisitDateFrom.getDate()
              ).getTime();

              if (today.getTime() < preInstallVisitDateFromTime) {
                set.status = 400;
                return "Pre Install Visit Date is not passed yet";
              }

              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature,
                {
                  preInstallVisitDateConfirmedTimestamp: new Date(),
                }
              );
            } else {
              await updateApplication(body.applicationId, {
                status: ApplicationStatusEnum.changesRequired,
                preInstallVisitDateFrom: null,
                preInstallVisitDateTo: null,
              });
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object(ApproveOrAskForChangesQueryBody),
          detail: {
            summary:
              "Gca Approve and confirm pre install visit date or Ask for Changes",
            description: `Approve and confirm pre install visit date or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/gca-complete-application",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            //TODO: rename function when time
            const errorChecks = await approveOrAskForChangesCheckHandler(
              ApplicationSteps.payment,
              body.applicationId,
              body.deadline,
              account
            );

            const application = errorChecks.data;

            if (errorChecks.errorCode !== 200 || !application) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            if (!application.paymentTxHash) {
              set.status = 400;
              return "No payment has been made yet";
            }

            const approvedValues = {
              applicationId: body.applicationId,
              deadline: body.deadline,
              devices: body.devices.map((device) => device.publicKey),
              txHash: application.paymentTxHash,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            const recoveredAddress = await recoverAddressHandler(
              applicationCompletedWithPaymentTypes,
              approvedValues,
              body.signature,
              gcaId
            );

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            if (application.status === ApplicationStatusEnum.completed) {
              set.status = 400;
              return "Application already completed";
            }

            if (application.farmId) {
              set.status = 400;
              return "Application already linked with a farm";
            }

            await handleCreateWithoutPIIDocumentsAndCompleteApplication(
              application,
              gcaId,
              body.signature,
              ApplicationSteps.payment,
              {
                ...body.withoutPIIdocuments,
                devices: body.devices,
              }
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-complete-application", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            signature: t.String(),
            deadline: t.Numeric(),
            annotation: t.Nullable(t.String()),
            devices: t.Array(
              t.Object({ publicKey: t.String(), shortId: t.String() })
            ),
            withoutPIIdocuments: t.Object({
              contractAgreementPresignedUrl: t.String(),
              mortgageStatementPresignedUrl: t.String(),
              propertyDeedPresignedUrl: t.String(),
              firstUtilityBillPresignedUrl: t.String(),
              secondUtilityBillPresignedUrl: t.String(),
              declarationOfIntentionPresignedUrl: t.String(),
              plansetsPresignedUrl: t.Nullable(t.String()),
              permitPresignedUrl: t.Nullable(t.String()),
              inspectionPresignedUrl: t.Nullable(t.String()),
              ptoPresignedUrl: t.Nullable(t.String()),
              miscDocuments: t.Array(
                t.Object({
                  presignedUrl: t.String(),
                  documentName: t.String(),
                })
              ),
            }),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/inspection-and-pto-approve-or-ask-for-changes",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            const errorChecks = await approveOrAskForChangesCheckHandler(
              body.stepIndex,
              body.applicationId,
              body.deadline,
              account
            );

            const application = errorChecks.data;

            if (errorChecks.errorCode !== 200 || !application) {
              set.status = errorChecks.errorCode;
              return errorChecks.errorMessage;
            }

            let approvedValues;
            let recoveredAddress;
            if (body.approved) {
              if (body.finalProtocolFee) {
                approvedValues = {
                  applicationId: body.applicationId,
                  approved: body.approved,
                  deadline: body.deadline,
                  finalProtocolFee: body.finalProtocolFee,
                  stepIndex: body.stepIndex,
                  // nonce is fetched from user account. nonce is updated for every new next-auth session
                };
              } else {
                set.status = 400;
                return "Final Protocol Fee is required in case of approval";
              }

              recoveredAddress = await recoverAddressHandler(
                stepApprovedWithFinalProtocolFeeTypes,
                approvedValues,
                body.signature,
                gcaId
              );
            } else {
              approvedValues = {
                applicationId: body.applicationId,
                approved: body.approved,
                deadline: body.deadline,
                stepIndex: body.stepIndex,
                // nonce is fetched from user account. nonce is updated for every new next-auth session
              };

              recoveredAddress = await recoverAddressHandler(
                stepApprovedTypes,
                approvedValues,
                body.signature,
                gcaId
              );
            }

            if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
              set.status = 403;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (
                !application.afterInstallVisitDateFrom ||
                !application.afterInstallVisitDateTo
              ) {
                set.status = 400;
                return "After Install Visit Dates are not set";
              }

              const now = new Date();
              const today = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate()
              );
              const afterInstallVisitDateFromTime = new Date(
                application.afterInstallVisitDateFrom.getFullYear(),
                application.afterInstallVisitDateFrom.getMonth(),
                application.afterInstallVisitDateFrom.getDate()
              ).getTime();

              if (today.getTime() < afterInstallVisitDateFromTime) {
                set.status = 400;
                return "After Install Visit Date is not passed yet";
              }

              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature,
                {
                  afterInstallVisitDateConfirmedTimestamp: new Date(),
                  finalProtocolFee: ethers.utils
                    .parseUnits(body.finalProtocolFee!!, 6)
                    .toBigInt(),
                }
              );
            } else {
              await updateApplication(body.applicationId, {
                status: ApplicationStatusEnum.changesRequired,
                afterInstallVisitDateFrom: null,
                afterInstallVisitDateTo: null,
              });
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-assigned-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            ...ApproveOrAskForChangesQueryBody,
            finalProtocolFee: t.Nullable(t.String()),
          }),
          detail: {
            summary:
              "Gca Approve and confirm pre install visit date or Ask for Changes",
            description: `Approve and confirm pre install visit date or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/gca-pre-install-visit",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }
            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (
              application.currentStep !== ApplicationSteps.permitDocumentation
            ) {
              set.status = 403;
              return "Application is not in the correct step";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForApproval
            ) {
              set.status = 403;
              return "Application is not in the correct status";
            }

            if (application.gcaAddress !== account.id) {
              set.status = 403;
              return "You are not assigned to this application";
            }

            const fromDate = new Date(body.preInstallVisitDateFrom);
            const toDate = new Date(body.preInstallVisitDateTo);

            if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
              set.status = 400;
              return "Invalid date format";
            }

            if (!application.estimatedInstallDate) {
              set.status = 400;
              return "Estimated Install Date is not set";
            }

            const now = new Date();
            const tomorrowTime = new Date(
              now.setDate(now.getDate() + 1)
            ).getTime();
            const fourDaysLaterTime = fromDate.getTime() + 86400000 * 4;

            if (
              fromDate.getTime() >= tomorrowTime ||
              toDate.getTime() <= fourDaysLaterTime ||
              toDate.getTime() >= application.estimatedInstallDate.getTime()
            ) {
              set.status = 400;
              return "Invalid date range";
            }

            await updateApplicationPreInstallVisitDates(
              body.applicationId,
              fromDate,
              toDate
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-pre-install-visit", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            preInstallVisitDateFrom: t.String(),
            preInstallVisitDateTo: t.String(),
          }),

          detail: {
            summary: "GCA Pre Install Visit",
            description: `Set the pre install visit dates`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/gca-after-install-visit",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }
            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (
              application.currentStep !==
              ApplicationSteps.inspectionAndPtoDocuments
            ) {
              set.status = 403;
              return "Application is not in the correct step";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForApproval
            ) {
              set.status = 403;
              return "Application is not in the correct status";
            }

            if (application.gcaAddress !== account.id) {
              set.status = 403;
              return "You are not assigned to this application";
            }

            const fromDate = new Date(body.afterInstallVisitDateFrom);
            const toDate = new Date(body.afterInstallVisitDateTo);

            if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
              set.status = 400;
              return "Invalid date format";
            }

            if (!application.intallFinishedDate) {
              set.status = 400;
              return "Install Finished Date is not set";
            }

            const oneDayInMillis = 86400000;
            const fourDaysInMillis = oneDayInMillis * 4;

            // Calculate the day after the install finished date
            const dayAfterInstallFinishedDate = new Date(
              application.intallFinishedDate.getTime() + oneDayInMillis
            );

            if (
              fromDate.getTime() < dayAfterInstallFinishedDate.getTime() ||
              toDate.getTime() < fromDate.getTime() + fourDaysInMillis
            ) {
              set.status = 400;
              return "Invalid date range";
            }

            await updateApplicationAfterInstallVisitDates(
              body.applicationId,
              new Date(body.afterInstallVisitDateFrom),
              new Date(body.afterInstallVisitDateTo)
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-pre-install-visit", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            afterInstallVisitDateFrom: t.String(),
            afterInstallVisitDateTo: t.String(),
          }),

          detail: {
            summary: "GCA After Install Visit",
            description: `Set the after install visit dates. If confirmed is true, it will set the confirmed timestamp`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
