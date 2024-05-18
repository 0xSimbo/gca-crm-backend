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
import { stepApprovedTypes } from "../../constants/typed-data/step-approval";
import { approveApplicationStep } from "../../db/mutations/applications/approveApplicationStep";
import { updateApplicationStatus } from "../../db/mutations/applications/updateApplicationStatus";
import { updateApplicationEnquiry } from "../../db/mutations/applications/updateApplicationEnquiry";
import { incrementApplicationStep } from "../../db/mutations/applications/incrementApplicationStep";
import { updatePreInstallDocuments } from "../../db/mutations/applications/updatePreInstallDocuments";

export const EnquiryQueryBody = t.Object({
  applicationId: t.Nullable(t.String()),
  establishedCostOfPowerPerKWh: t.Numeric({
    example: 0.12,
    minimum: 0,
  }),
  enquiryEstimatedFees: t.Numeric({
    example: 109894,
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
    minLength: 10, // TODO: match in frontend
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

export const ApproveOrAskForChangesQueryBody = t.Object({
  applicationId: t.String(),
  signature: t.String(),
  deadline: t.Numeric(),
  approved: t.Boolean(),
  annotation: t.Nullable(t.String()),
  stepIndex: t.Numeric(),
});

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
        "/approve-or-ask-for-changes",
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

            // deadline max 10minutes
            if (body.deadline > Date.now() / 1000 + 600) {
              set.status = 403;
              return "Deadline is too far in the future";
            }

            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForApproval
            ) {
              set.status = 403;
              return "Application is not in waitingForApproval status";
            }

            if (application.currentStep !== body.stepIndex) {
              set.status = 403;
              return "Invalid step index";
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
          body: ApproveOrAskForChangesQueryBody,
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
            console.log("gca-assigned-applications", { applications, gcaId });
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
              if (application.userId !== userId) {
                set.status = 403;
                return "Unauthorized";
              }
              if (
                application.status !== ApplicationStatusEnum.changesRequired
              ) {
                set.status = 403;
                return "Application is not in changesRequired status";
              }
              if (application.currentStep !== ApplicationSteps.enquiry) {
                set.status = 403;
                return "Application is not in enquiry step";
              }

              const { applicationId, ...updateObject } = body;
              await updateApplicationEnquiry(body.applicationId, {
                ...updateObject,
                establishedCostOfPowerPerKWh:
                  body.establishedCostOfPowerPerKWh.toString(),
                enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                estimatedKWhGeneratedPerYear:
                  body.estimatedKWhGeneratedPerYear.toString(),
                lat: body.lat.toString(),
                lng: body.lng.toString(),
              });
              return body.applicationId;
            }
            const insertedId = await createApplication({
              userId,
              ...body,
              establishedCostOfPowerPerKWh:
                body.establishedCostOfPowerPerKWh.toString(),
              estimatedKWhGeneratedPerYear:
                body.estimatedKWhGeneratedPerYear.toString(),
              enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
              lat: body.lat.toString(),
              lng: body.lng.toString(),
              createdAt: new Date(),
              farmId: null,
              currentStep: 1,
              //TODO remove when @0xSimbo finished roundRobin implementation
              gcaAssignedTimestamp: new Date(),
              gcaAddress: "0x18a0bA01Bbec4aa358650d297Ba7bB330a78B073",
              roundRobinStatus: RoundRobinStatusEnum.waitingToBeAccepted,
              // roundRobinStatus: RoundRobinStatusEnum.waitingToBeAssigned,
              status: ApplicationStatusEnum.waitingForApproval,
              updatedAt: null,
              finalQuotePerWatt: null,
              preInstallVisitDateFrom: null,
              preInstallVisitDateTo: null,
              afterInstallVisitDateFrom: null,
              afterInstallVisitDateTo: null,
              installDate: null,
              intallFinishedDate: null,
              paymentTxHash: null,
              finalProtocolFee: null,
              paymentDate: null,
              gcaAcceptanceTimestamp: null,
            });
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
            if (application.userId !== userId) {
              set.status = 403;
              return "Unauthorized";
            }
            if (
              application.status !== ApplicationStatusEnum.draft &&
              application.status !== ApplicationStatusEnum.changesRequired
            ) {
              set.status = 403;
              return "Pre-install documents can only be uploaded in draft or changesRequired status";
            }
            if (
              application.currentStep !== ApplicationSteps.preInstallDocuments
            ) {
              set.status = 403;
              return "Application is not in preInstallDocuments step";
            }

            if (
              body.plansetsNotAvailableReason &&
              body.plansetsPresignedUrl === null
            ) {
              await updatePreInstallDocuments(
                body.applicationId,
                application.status,
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
              await updatePreInstallDocuments(
                body.applicationId,
                application.status,
                {
                  ...body,
                  plansetsNotAvailableReason: null,
                  plansetsPresignedUrl: body.plansetsPresignedUrl,
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
            console.log("[applicationsRouter] create-application", e);
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
  );
