import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { GetEntityByIdPathParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { createApplication } from "../../db/mutations/applications/createApplication";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
  EncryptedMasterKeySet,
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
import { updateApplicationPreInstallVisitDate } from "../../db/mutations/applications/updateApplicationPreInstallVisitDate";
import { updateApplicationAfterInstallVisitDate } from "../../db/mutations/applications/updateApplicationAfterInstallVisitDate";
import { handleCreateOrUpdateAfterInstallDocuments } from "./steps/after-install";
import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { roundRobinAssignement } from "../../db/queries/gcas/roundRobinAssignement";
import {
  getProtocolFeePaymentFromTransactionHash,
  GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual,
} from "../../subgraph/queries/getProtocolFeePaymentFromTransactionHash";
import { ethers } from "ethers";
import { handleCreateWithoutPIIDocumentsAndCompleteApplication } from "./steps/gca-application-completion";
import { db } from "../../db/db";
import { applicationsDraft } from "../../db/schema";

import { convertKWhToMWh } from "../../utils/format/convertKWhToMWh";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { findAllApplicationsByOrganizationId } from "../../db/queries/applications/findAllApplicationsByOrganizationId";
import { findOrganizationById } from "../../db/queries/organizations/findOrganizationById";
import { PermissionsEnum } from "../../types/api-types/Permissions";
import { createOrganizationApplication } from "../../db/mutations/organizations/createOrganizationApplication";
import { deleteOrganizationApplication } from "../../db/mutations/organizations/deleteOrganizationApplication";
import { findFirstOrganizationApplicationByApplicationId } from "../../db/queries/applications/findFirstOrganizationApplicationByApplicationId";
import { findAllOrganizationMembers } from "../../db/queries/organizations/findAllOrganizationMembers";
import { findFirstDelegatedUserByUserId } from "../../db/queries/gcaDelegatedUsers/findFirstDelegatedUserByUserId";

const encryptedFileUpload = t.Object({
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
  orgMembersMasterkeys: t.Array(
    t.Object({
      orgUserId: t.String(),
      encryptedMasterKey: t.String(),
    })
  ),
});

export type EncryptedFileUploadType = {
  publicUrl: string;
  keysSet: EncryptedMasterKeySet[];
  orgMembersMasterkeys: {
    orgUserId: string;
    encryptedMasterKey: string;
  }[];
};

export const EnquiryQueryBody = t.Object({
  applicationId: t.String(),
  latestUtilityBill: encryptedFileUpload,
  estimatedCostOfPowerPerKWh: t.Numeric({
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
  farmOwnerName: t.String({
    example: "John Doe",
    minLength: 2,
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
  contractAgreement: encryptedFileUpload,
  declarationOfIntention: encryptedFileUpload,
});

export const PermitDocumentationQueryBody = t.Object({
  applicationId: t.String(),
  estimatedInstallDate: t.Date(),
});

export const InspectionAndPTOQueryBody = t.Object({
  applicationId: t.String(),
  plansets: t.Nullable(encryptedFileUpload),
  plansetsNotAvailableReason: t.Nullable(t.String()),
  cityPermit: t.Nullable(encryptedFileUpload),
  cityPermitNotAvailableReason: t.Nullable(t.String()),
  inspection: t.Nullable(encryptedFileUpload),
  inspectionNotAvailableReason: t.Nullable(t.String()),
  pto: t.Nullable(encryptedFileUpload),
  firstUtilityBill: encryptedFileUpload,
  secondUtilityBill: encryptedFileUpload,
  mortgageStatement: t.Nullable(encryptedFileUpload),
  propertyDeed: t.Nullable(encryptedFileUpload),
  ptoNotAvailableReason: t.Nullable(t.String()),
  installFinishedDate: t.Date(),
  miscDocuments: t.Array(
    t.Object({
      name: t.String(),
      encryptedFileUpload,
      extension: t.Union([
        t.Literal("pdf"),
        t.Literal("png"),
        t.Literal("jpg"),
        t.Literal("jpeg"),
      ]),
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
                const organizationApplication =
                  await findFirstOrganizationApplicationByApplicationId(
                    query.id
                  );

                if (!organizationApplication) {
                  const gcaDelegatedUser = await findFirstDelegatedUserByUserId(
                    userId
                  );

                  if (!gcaDelegatedUser) {
                    set.status = 400;
                    return "Unauthorized";
                  }
                } else {
                  const isOrganizationOwner =
                    organizationApplication.organization.ownerId === userId;

                  const organizationMember =
                    await findOrganizationMemberByUserId(
                      organizationApplication.organization.id,
                      userId
                    );

                  // isOwner or has permission to read applications or has permission to pay protocol fees and application is waiting for payment
                  const isAuthorized =
                    isOrganizationOwner ||
                    organizationMember?.role.rolePermissions.find(
                      (p) =>
                        p.permission.key === PermissionsEnum.ApplicationsRead
                    ) ||
                    (organizationMember?.role.rolePermissions.find(
                      (p) =>
                        p.permission.key === PermissionsEnum.ProtocolFeePayment
                    ) &&
                      application.status ===
                        ApplicationStatusEnum.waitingForPayment);

                  if (!isAuthorized) {
                    set.status = 400;
                    return "Unauthorized";
                  }
                }
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
      .get(
        "/all-applications-by-organization-id",
        async ({ query, set, userId }) => {
          if (!query.organizationId)
            throw new Error("organizationId is required");
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 400;

              return "Unauthorized";
            }

            const organization = await findOrganizationById(
              query.organizationId
            );

            const isOrganizationOwner = organization?.ownerId === userId;

            const organizationMember = await findOrganizationMemberByUserId(
              query.organizationId,
              userId
            );

            const isAuthorized =
              isOrganizationOwner ||
              organizationMember?.role.rolePermissions.find(
                (p) =>
                  p.permission.key === PermissionsEnum.ApplicationsRead ||
                  p.permission.key === PermissionsEnum.ProtocolFeePayment
              );

            const applications = await findAllApplicationsByOrganizationId(
              query.organizationId
            );

            if (!isAuthorized) {
              // return only applications owned by the user
              return applications.filter((c) => c.user.id === userId);
            }

            return applications;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /all-applications-by-organization-id",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            organizationId: t.String(),
          }),
          detail: {
            summary: "Get all applications by organization ID",
            description: `Get all applications by organization ID and check if the user is authorized to view applications`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/add-application-to-organization",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 400;

              return "Unauthorized";
            }

            const organizationMember = await findOrganizationMemberByUserId(
              body.organizationId,
              userId
            );

            if (!organizationMember) {
              set.status = 400;
              return "User is not a member of the organization";
            }

            const isAuthorized = organizationMember?.role.rolePermissions.find(
              (p) => p.permission.key === PermissionsEnum.ApplicationsShare
            );

            if (!isAuthorized) {
              set.status = 400;
              return "User does not have the required permissions";
            }

            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application.userId !== userId) {
              set.status = 400;
              return "User is not the owner of the application";
            }

            if (
              application.organizationApplication?.organizationId ===
              body.organizationId
            ) {
              set.status = 400;
              return "Application already added to organization";
            }

            const delegatedDocumentsEncryptedMasterKeys =
              body.delegatedDocumentsEncryptedMasterKeysByOrganizationUserId
                .map(
                  ({
                    organizationUserId,
                    delegatedDocumentsEncryptedMasterKeys,
                  }) =>
                    delegatedDocumentsEncryptedMasterKeys.map((c) => ({
                      organizationUserId,
                      documentId: c.documentId,
                      encryptedMasterKey: c.encryptedMasterKey,
                    }))
                )
                .flat();

            await createOrganizationApplication(
              organizationMember.id,
              body.organizationId,
              body.applicationId,
              delegatedDocumentsEncryptedMasterKeys
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /add-application-to-organization",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            applicationId: t.String(),
            delegatedDocumentsEncryptedMasterKeysByOrganizationUserId: t.Array(
              t.Object({
                organizationUserId: t.String(),
                delegatedDocumentsEncryptedMasterKeys: t.Array(
                  t.Object({
                    documentId: t.String(),
                    encryptedMasterKey: t.String(),
                  })
                ),
              })
            ),
          }),
          detail: {
            summary: "Add application to organization",
            description: `Add application to organization and check if the user is authorized to add applications to the organization`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/cancel-or-resume-application",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 400;
              return "Unauthorized";
            }

            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application.userId !== userId) {
              set.status = 400;
              return "User is not the owner of the application";
            }

            await updateApplication(application.id, {
              isCancelled: body.cancel,
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] /cancel-application", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            cancel: t.Boolean(),
            applicationId: t.String(),
          }),
          detail: {
            summary: "Cancel or Resume Application",
            description: `Cancel or Resume Application and check if the user is authorized to cancel the application`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/remove-application-to-organization",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 400;

              return "Unauthorized";
            }

            const organization = await findOrganizationById(
              body.organizationId
            );

            const isOrganizationOwner = organization?.ownerId === userId;

            const organizationMember = await findOrganizationMemberByUserId(
              body.organizationId,
              userId
            );

            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            const isAuthorized =
              isOrganizationOwner ||
              organizationMember?.role.rolePermissions.find(
                (p) => p.permission.key === PermissionsEnum.ApplicationsShare
              ) ||
              application?.userId === userId;

            if (!isAuthorized) {
              set.status = 400;
              return "Unauthorized";
            }

            if (application.userId !== userId) {
              set.status = 400;
              return "Unauthorized";
            }

            await deleteOrganizationApplication(
              body.organizationId,
              body.applicationId
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /remove-organization-application",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            applicationId: t.String(),
          }),
          detail: {
            summary: "Add application to organization",
            description: `Add application to organization and check if the user is authorized to add applications to the organization`,
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
              set.status = 400;
              return "Invalid Signature";
            }

            if (body.approved) {
              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature,
                {
                  status: ApplicationStatusEnum.draft,
                  currentStep: body.stepIndex + 1,
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
              set.status = 400;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (!body.finalQuotePerWatt) {
                set.status = 400;
                return "finalQuotePerWatt is required";
              }

              if (!body.revisedKwhGeneratedPerYear) {
                set.status = 400;
                return "revisedKwhGeneratedPerYear is required";
              }

              const protocolFees =
                parseFloat(body.finalQuotePerWatt) *
                parseFloat(convertKWhToMWh(body.revisedKwhGeneratedPerYear)) *
                1e6;

              // console.log("protocolFees", protocolFees);

              await approveApplicationStep(
                body.applicationId,
                account.id,
                body.annotation,
                body.stepIndex,
                body.signature,
                {
                  status: ApplicationStatusEnum.approved,
                  finalQuotePerWatt: body.finalQuotePerWatt,
                  revisedEstimatedProtocolFees: protocolFees.toString(),
                  revisedKwhGeneratedPerYear: body.revisedKwhGeneratedPerYear,
                  revisedCostOfPowerPerKWh: body.revisedCostOfPowerPerKWh,
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
            revisedKwhGeneratedPerYear: t.Nullable(t.String()),
            revisedCostOfPowerPerKWh: t.Nullable(t.String()),
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
              set.status = 400;
              return "Unauthorized";
            }

            if (body.deadline < Date.now() / 1000) {
              set.status = 400;
              return "Deadline has passed";
            }

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
              set.status = 400;
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
              set.status = 400;
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
              set.status = 400;
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
                set.status = 400;

                return "Unauthorized";
              }
            }
            const gcaDelegatedUsers = await findFirstDelegatedUserByUserId(id);
            if (gcaDelegatedUsers) {
              const applications = await findAllApplicationsAssignedToGca(
                gcaDelegatedUsers.gcaId
              );
              return applications;
            }
            const applications = await findAllApplicationsByUserId(id);
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
      .get(
        "/new-application-id",
        async ({ set, userId }) => {
          try {
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.role !== "USER") {
              set.status = 400;
              return "Unauthorized";
            }

            const insert = await db
              .insert(applicationsDraft)
              .values({
                userId,
                createdAt: new Date(),
              })
              .returning({ id: applicationsDraft.id });

            return insert[0].id;
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
            const existingApplication = await FindFirstApplicationById(
              body.applicationId
            );

            console.log("existingApplication", existingApplication?.id);
            if (!existingApplication) {
              const gcaAddress = await roundRobinAssignement();
              await createApplication(
                body.latestUtilityBill.publicUrl,
                body.latestUtilityBill.keysSet,
                {
                  id: body.applicationId,
                  userId,
                  ...body,
                  estimatedCostOfPowerPerKWh:
                    body.estimatedCostOfPowerPerKWh.toString(),
                  estimatedKWhGeneratedPerYear:
                    body.estimatedKWhGeneratedPerYear.toString(),
                  enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                  enquiryEstimatedQuotePerWatt:
                    body.enquiryEstimatedQuotePerWatt.toString(),
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                  createdAt: new Date(),
                  currentStep: 1,
                  gcaAssignedTimestamp: new Date(),
                  gcaAddress,
                  roundRobinStatus: RoundRobinStatusEnum.waitingToBeAccepted,
                  status: ApplicationStatusEnum.waitingForApproval,
                }
              );
            } else {
              const errorChecks = await fillApplicationStepCheckHandler(
                userId,
                existingApplication,
                ApplicationSteps.enquiry
              );

              if (errorChecks) {
                set.status = errorChecks.errorCode;
                return errorChecks.errorMessage;
              }

              const { applicationId, ...updateObject } = body;
              await updateApplicationEnquiry(
                existingApplication.id,
                existingApplication.organizationApplication?.id,
                body.latestUtilityBill,
                {
                  ...updateObject,
                  estimatedCostOfPowerPerKWh:
                    body.estimatedCostOfPowerPerKWh.toString(),
                  enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                  enquiryEstimatedQuotePerWatt:
                    body.enquiryEstimatedQuotePerWatt.toString(),
                  estimatedKWhGeneratedPerYear:
                    body.estimatedKWhGeneratedPerYear.toString(),
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                }
              );
            }

            return body.applicationId;
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

            await handleCreateOrUpdatePreIntallDocuments(
              application,
              application.organizationApplication?.id,
              ApplicationSteps.preInstallDocuments,
              {
                ...body,
              }
            );

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
            description: `insert the pre-install documents in db and update the application status to waitingForApproval`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/estimated-install-date",
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

            await handleCreateOrUpdatePermitDocumentation(application, {
              estimatedInstallDate: body.estimatedInstallDate,
            });

            return body.applicationId;
          } catch (e) {
            console.error("error", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /estimated-install-date", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: PermitDocumentationQueryBody,
          detail: {
            summary: "Create or Update the estimated install date",
            description: `insert the estimated install date in db and update the application status to waitingForApproval`,
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

            if (!body.inspection && !body.inspectionNotAvailableReason) {
              set.status = 400;
              return "Either inspection file or inspectionNotAvailableReason is required";
            }

            if (!body.pto && !body.ptoNotAvailableReason) {
              set.status = 400;
              return "Either pto file or ptoNotAvailableReason is required";
            }

            if (!body.cityPermit && !body.cityPermitNotAvailableReason) {
              set.status = 400;
              return "Either cityPermit file or cityPermitNotAvailableReason is required";
            }

            if (!body.mortgageStatement && !body.propertyDeed) {
              set.status = 400;
              return "Either mortgageStatement or propertyDeed is required";
            }

            if (
              body.miscDocuments.some(
                (doc) => !doc.name.toLowerCase().includes("misc")
              )
            ) {
              set.status = 400;
              return "Every miscDocuments name should include the word 'misc'";
            }

            await handleCreateOrUpdateAfterInstallDocuments(
              application,
              application.organizationApplication?.id,
              {
                ...body,
              }
            );
            return body.applicationId;
          } catch (e) {
            console.error("error", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] /inspection-and-pto", e);
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
              const organizationApplication =
                await findFirstOrganizationApplicationByApplicationId(
                  body.applicationId
                );

              if (!organizationApplication) {
                set.status = 400;
                return "Unauthorized";
              }

              const isOrganizationOwner =
                organizationApplication.organization.ownerId === userId;

              const organizationMember = await findOrganizationMemberByUserId(
                organizationApplication.organization.id,
                userId
              );

              const isAuthorized =
                isOrganizationOwner ||
                organizationMember?.role.rolePermissions.find(
                  (p) => p.permission.key === PermissionsEnum.ProtocolFeePayment
                );

              if (!isAuthorized) {
                set.status = 400;
                return "Unauthorized";
              }
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForPayment
            ) {
              set.status = 400;
              return "Application is not waiting for payment";
            }

            if (process.env.NODE_ENV === "production") {
              const protocolFeeData: GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual | null =
                await getProtocolFeePaymentFromTransactionHash(body.txHash);

              if (!protocolFeeData) {
                set.status = 400;
                return "Invalid Transaction Hash";
              }

              if (protocolFeeData.user.id !== userId) {
                const organizationApplication =
                  await findFirstOrganizationApplicationByApplicationId(
                    body.applicationId
                  );

                if (!organizationApplication) {
                  set.status = 400;
                  return "The transaction hash does not belong to the user";
                }

                const organizationMembers = await findAllOrganizationMembers(
                  organizationApplication.organization.id
                );

                const allowedWallets = organizationMembers
                  .filter((m) =>
                    m.role.rolePermissions.find(
                      (p) =>
                        p.permission.key === PermissionsEnum.ProtocolFeePayment
                    )
                  )
                  .map((c) => c.userId);

                if (!allowedWallets.includes(protocolFeeData.user.id)) {
                  set.status = 400;
                  return "The transaction hash does not belong to the user or any of the organization members allowed to pay the protocol fee";
                }
              }

              if (BigInt(application.finalProtocolFee) === BigInt(0)) {
                set.status = 400;
                return "Final Protocol Fee is not set";
              }

              /// TODO: If it's greater, need to check with david what to do on that. For now, let's not change anything
              if (
                BigInt(protocolFeeData.amount) <
                BigInt(application.finalProtocolFee)
              ) {
                set.status = 400;
                return "Invalid Amount";
              }
            }

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
              set.status = 400;
              return "Unauthorized";
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 400;
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
              set.status = 400;
              return "Unauthorized";
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 400;
              return "Application is not Approved";
            }
            if (
              application.currentStep !== ApplicationSteps.preInstallDocuments
            ) {
              set.status = 400;
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
        "/gca-resume-quote-rejected",
        async ({ query, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              query.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            const account = await findFirstAccountById(userId);

            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.role !== "GCA") {
              set.status = 400;
              return "Unauthorized";
            }

            if (application.status !== ApplicationStatusEnum.quoteRejected) {
              set.status = 400;
              return "Application is not in quoteRejected status";
            }

            if (
              application.currentStep !== ApplicationSteps.preInstallDocuments
            ) {
              set.status = 400;
              return "Action not authorized";
            }

            await updateApplicationStatus(
              query.applicationId,
              ApplicationStatusEnum.approved
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] gca-resume-quote-rejected", e);
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
        "/pre-install-visit-approve-or-ask-for-changes",
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
              set.status = 400;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (!application.preInstallVisitDate) {
                set.status = 400;
                return "Pre Install Visit Date is not set";
              }

              const now = new Date();
              const today = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate()
              );
              const preInstallVisitDateTime = new Date(
                application.preInstallVisitDate.getFullYear(),
                application.preInstallVisitDate.getMonth(),
                application.preInstallVisitDate.getDate()
              ).getTime();

              if (today.getTime() < preInstallVisitDateTime) {
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
                  status: ApplicationStatusEnum.draft,
                  preInstallVisitDateConfirmedTimestamp: new Date(),
                  currentStep: body.stepIndex + 1,
                }
              );
            } else {
              await updateApplication(body.applicationId, {
                status: ApplicationStatusEnum.changesRequired,
                preInstallVisitDate: null,
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
              set.status = 400;
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
                finalAuditReport: body.finalAuditReport,
                ...body.withoutPIIdocuments,
                miscDocuments: body.miscDocuments,
                devices: body.devices,
              }
            );
            //TODO: send event with kafka to notify that the application is completed and publish audit;
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
            finalAuditReport: t.String(),
            miscDocuments: t.Array(
              t.Object({
                publicUrl: t.String(),
                documentName: t.String(),
                extension: t.String(),
              })
            ),
            withoutPIIdocuments: t.Object({
              contractAgreement: t.String(),
              mortgageStatement: t.String(),
              propertyDeed: t.String(),
              firstUtilityBill: t.String(),
              secondUtilityBill: t.String(),
              declarationOfIntention: t.String(),
              plansets: t.Nullable(t.String()),
              cityPermit: t.Nullable(t.String()),
              inspection: t.Nullable(t.String()),
              pto: t.Nullable(t.String()),
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
              set.status = 400;
              return "Invalid Signature";
            }

            if (body.approved) {
              if (!application.afterInstallVisitDate) {
                set.status = 400;
                return "After Install Visit Date is not set";
              }

              const now = new Date();
              const today = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate()
              );
              const afterInstallVisitDateTime = new Date(
                application.afterInstallVisitDate.getFullYear(),
                application.afterInstallVisitDate.getMonth(),
                application.afterInstallVisitDate.getDate()
              ).getTime();

              if (today.getTime() < afterInstallVisitDateTime) {
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
                  status: ApplicationStatusEnum.approved,
                  afterInstallVisitDateConfirmedTimestamp: new Date(),
                  finalProtocolFee: ethers.utils
                    .parseUnits(body.finalProtocolFee!!, 6)
                    .toBigInt(),
                }
              );
            } else {
              await updateApplication(body.applicationId, {
                status: ApplicationStatusEnum.changesRequired,
                afterInstallVisitDate: null,
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
              set.status = 400;
              return "Application is not in the correct step";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForApproval
            ) {
              set.status = 400;
              return "Application is not in the correct status";
            }

            if (application.gcaAddress !== account.id) {
              set.status = 400;
              return "You are not assigned to this application";
            }

            const preInstallVisitDate = new Date(body.preInstallVisitDate);

            if (isNaN(preInstallVisitDate.getTime())) {
              set.status = 400;
              return "Invalid date format";
            }

            if (!application.estimatedInstallDate) {
              set.status = 400;
              return "Estimated Install Date is not set";
            }

            const today = new Date(
              new Date().getFullYear(),
              new Date().getMonth(),
              new Date().getDate()
            );
            const tomorrowTime = new Date(today.getTime() + 86400000).getTime();
            //TODO: Uncomment this after finishing migrating old farms
            // if (
            //   preInstallVisitDate.getTime() <= tomorrowTime ||
            //   preInstallVisitDate.getTime() >=
            //     application.estimatedInstallDate.getTime()
            // ) {
            //   set.status = 400;
            //   return "Invalid date";
            // }

            await updateApplicationPreInstallVisitDate(
              body.applicationId,
              preInstallVisitDate
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
            preInstallVisitDate: t.Date(),
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
              set.status = 400;
              return "Application is not in the correct step";
            }

            if (
              application.status !== ApplicationStatusEnum.waitingForApproval
            ) {
              set.status = 400;
              return "Application is not in the correct status";
            }

            if (application.gcaAddress !== account.id) {
              set.status = 400;
              return "You are not assigned to this application";
            }

            const afterInstallVisitDate = new Date(body.afterInstallVisitDate);

            if (isNaN(afterInstallVisitDate.getTime())) {
              set.status = 400;
              return "Invalid date format";
            }

            if (!application.installFinishedDate) {
              set.status = 400;
              return "Install Finished Date is not set";
            }

            // Calculate the day after the install finished date
            const dayAfterInstallFinishedDate = new Date(
              application.installFinishedDate.getTime()
            );

            //TODO: Uncomment this after finishing migrating old farms
            // if (
            //   afterInstallVisitDate.getTime() <
            //   dayAfterInstallFinishedDate.getTime()
            // ) {
            //   set.status = 400;
            //   return "Invalid date";
            // }

            await updateApplicationAfterInstallVisitDate(
              body.applicationId,
              new Date(body.afterInstallVisitDate)
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
            afterInstallVisitDate: t.Date(),
          }),

          detail: {
            summary: "GCA After Install Visit",
            description: `Set the after install visit dates. If confirmed is true, it will set the confirmed timestamp`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
