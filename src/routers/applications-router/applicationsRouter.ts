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

import { handleCreateOrUpdatePreIntallDocuments } from "./steps/pre-install";
import { updateApplicationPreInstallVisitDate } from "../../db/mutations/applications/updateApplicationPreInstallVisitDate";
import { updateApplicationAfterInstallVisitDate } from "../../db/mutations/applications/updateApplicationAfterInstallVisitDate";
import { handleCreateOrUpdateAfterInstallDocuments } from "./steps/after-install";
import {
  updateApplication,
  updateApplicationCRSFields,
} from "../../db/mutations/applications/updateApplication";
import { roundRobinAssignement } from "../../db/queries/gcas/roundRobinAssignement";

import { BigNumber, ethers } from "ethers";
import { handleCreateWithoutPIIDocumentsAndCompleteApplication } from "./steps/gca-application-completion";
import { db } from "../../db/db";
import { OrganizationUsers, applicationsDraft } from "../../db/schema";

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
import { findAllUserJoinedOrganizations } from "../../db/queries/organizations/findAllUserJoinedOrganizations";
import { findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId } from "../../db/queries/organizations/findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId";
import { findFirstDelegatedEncryptedMasterKeyByApplicationId } from "../../db/queries/organizations/findFirstDelegatedEncryptedMasterKeyByApplicationId";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";
import { findFirstApplicationMasterKeyByApplicationIdAndUserId } from "../../db/queries/applications/findFirstApplicationMasterKeyByApplicationIdAndUserId";
import {
  findAllCompletedApplications,
  findCompletedApplication,
} from "../../db/queries/applications/findAllCompletedApplications";
import { findAllApplicationsWithoutMasterKey } from "../../db/queries/applications/findAllApplicationsWithoutMasterKey";
import { createApplicationEncryptedMasterKeysForUsers } from "../../db/mutations/applications/createApplicationEncryptedMasterKeysForUsers";
import { findAllApplications } from "../../db/queries/applications/findAllApplications";
import {
  GetProtocolFeePaymentFromTxHashReceipt,
  getProtocolFeePaymentFromTxHashReceipt,
} from "../../utils/getProtocolFeePaymentFromTxHashReceipt";
import { findAllApplicationsOwnersByIds } from "../../db/queries/applications/findAllApplicationsOwnersByIds";
import { createOrganizationApplicationBatch } from "../../db/mutations/organizations/createOrganizationApplicationBatch";
import { deleteOrganizationApplicationBatch } from "../../db/mutations/organizations/deleteOrganizationApplicationBatch";
import { findAllApplicationsByOrgUserId } from "../../db/queries/applications/findAllApplicationsByOrgUserId";
import { eq } from "drizzle-orm";
import { findFirstOrgMemberwithShareAllApplications } from "../../db/queries/organizations/findFirstOrgMemberwithShareAllApplications";
import { findOrganizationsMemberByUserIdAndOrganizationIds } from "../../db/queries/organizations/findOrganizationsMemberByUserIdAndOrganizationIds";
import { findUsedTxHash } from "../../db/queries/applications/findUsedTxHash";
import { patchDeclarationOfIntention } from "../../db/mutations/applications/patchDeclarationOfIntention";
import { createGlowEventEmitter, eventTypes } from "@glowlabs-org/events-sdk";
import { weeklyProduction, weeklyCarbonDebt } from "../../db/schema";
import {
  WeeklyProductionSchema,
  WeeklyCarbonDebtSchema,
  EnquiryQueryBody,
  DeclarationOfIntentionMissingQueryBody,
  PreInstallDocumentsQueryBody,
  InspectionAndPTOQueryBody,
  GcaAcceptApplicationQueryBody,
  ApproveOrAskForChangesQueryBody,
} from "./query-schemas";
import { findFirstApplicationDraftByUserId } from "../../db/queries/applications/findFirstApplicationDraftByUserId";

export const applicationsRouter = new Elysia({ prefix: "/applications" })
  .use(bearerplugin())
  .get(
    "/completed",
    async ({ query: { withDocuments }, set }) => {
      try {
        const applications = await findAllCompletedApplications(
          !!withDocuments
        );

        return applications;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[applicationsRouter] /completed", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        withDocuments: t.Optional(t.Literal("true")),
      }),
      detail: {
        summary: "Get all completed applications ",
        description: `Get all completed applications `,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/completed/by",
    async ({ query, set }) => {
      try {
        const { farmId, publicKey, shortId } = query;
        if (!farmId && !publicKey && !shortId) {
          set.status = 400;
          return "You must provide one of: farmId, publicKey, or shortId";
        }
        const application = await findCompletedApplication({
          farmId,
          publicKey,
          shortId,
        });
        if (!application) {
          set.status = 404;
          return "Completed application not found";
        }
        return application;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        farmId: t.Optional(t.String()),
        publicKey: t.Optional(t.String()),
        shortId: t.Optional(t.String()),
      }),
      detail: {
        summary:
          "Get one completed application by farmId, publicKey, or shortId",
        description: `Returns a completed application for a farm or device. Prioritizes: publicKey > shortId > farmId.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
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
        "/edit-application-allowed",
        async ({ query, error, userId }) => {
          if (!query.id) throw new Error("ID is required");
          try {
            const application = await FindFirstApplicationById(query.id);
            if (!application) {
              return error(404, "Application not found");
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
                  return error(400, "Unauthorized");
                } else {
                  const organizationMember =
                    await findOrganizationMemberByUserId(
                      organizationApplication.organization.id,
                      userId
                    );
                  const isAuthorized = false;
                  // organizationMember?.role.rolePermissions.find(
                  //   (p) =>
                  //     p.permission.key === PermissionsEnum.ApplicationsEdit
                  // )
                  //TODO: implement application edit permission

                  if (!isAuthorized) {
                    return error(400, "Unauthorized");
                  }
                }
              }
            }
            if (
              application.status !== ApplicationStatusEnum.draft &&
              application.status !== ApplicationStatusEnum.changesRequired
            ) {
              return error(403, "Application is not in the correct status");
            }
            if (application.currentStep !== query.stepIndex) {
              return error(403, "Application is not in the correct step");
            }

            return true;
          } catch (e) {
            if (e instanceof Error) {
              return error(400, e.message);
            } else {
              console.log("[applicationsRouter] edit-application-allowed", e);
              return error(500, "Error Occured");
            }
          }
        },
        {
          query: t.Object({
            id: t.String(),
            stepIndex: t.Number(),
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

            await createOrganizationApplication(
              organizationMember.id,
              body.organizationId,
              body.applicationId,
              body.delegatedApplicationsEncryptedMasterKeys
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
            delegatedApplicationsEncryptedMasterKeys: t.Array(
              t.Object({
                userId: t.String(),
                encryptedMasterKey: t.String(),
                applicationId: t.String(),
                organizationUserId: t.String(),
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
        "/share-all-applications-to-organization",
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

            const isAlreadyShardingAllApplications =
              await findFirstOrgMemberwithShareAllApplications(userId);

            if (isAlreadyShardingAllApplications) {
              set.status = 400;
              return "User is already sharing all applications with an organization";
            }

            const isAuthorized = organizationMember?.role.rolePermissions.find(
              (p) => p.permission.key === PermissionsEnum.ApplicationsShare
            );

            if (!isAuthorized) {
              set.status = 400;
              return "User does not have the required permissions";
            }

            const applications = await findAllApplicationsOwnersByIds(
              body.applicationIds
            );

            if (applications.length !== body.applicationIds.length) {
              set.status = 404;
              return "Application not found";
            }

            if (applications.some((a) => a.user.id !== userId)) {
              set.status = 400;
              return "User is not the owner of the application";
            }

            if (body.applicationIds.length === 0) {
              await db
                .update(OrganizationUsers)
                .set({
                  shareAllApplications: true,
                })
                .where(eq(OrganizationUsers.id, organizationMember.id));
            } else {
              await createOrganizationApplicationBatch(
                organizationMember.id,
                body.organizationId,
                body.applicationIds,
                body.delegatedApplicationsEncryptedMasterKeys
              );
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /share-all-applications-to-organization",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            applicationIds: t.Array(t.String()),
            delegatedApplicationsEncryptedMasterKeys: t.Array(
              t.Object({
                userId: t.String(),
                encryptedMasterKey: t.String(),
                applicationId: t.String(),
                organizationUserId: t.String(),
              })
            ),
          }),
          detail: {
            summary: "Share all org member applications with the organization",
            description: `share all org member applications with the organization`,
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
            summary: "Remove application from organization",
            description: `Remove application from organization and check if the user is authorized to remove the application from the organization`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/remove-org-user-applications-from-organization",
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

            const organizationMember = await findOrganizationMemberByUserId(
              body.organizationId,
              userId
            );

            if (!organizationMember) {
              set.status = 400;
              return "Unauthorized";
            }

            const allOrgUserApplications = await findAllApplicationsByOrgUserId(
              organizationMember.id
            );

            await deleteOrganizationApplicationBatch(
              organizationMember.id,
              body.organizationId,
              allOrgUserApplications.map((a) => a.id)
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /remove-org-user-applications-from-organization",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
          }),
          detail: {
            summary: "Remove applications from organization",
            description: `Remove applications from organization and check if the user is authorized to remove applications from the organization`,
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
            console.log(
              "[applicationsRouter] enquiry-approve-or-ask-for-changes",
              e
            );
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
            console.log(
              "[applicationsRouter] pre-install-documents-approve-or-ask-for-changes",
              e
            );
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
            console.log(
              "[applicationsRouter] gca-accept-or-defer-application-assignement",
              e
            );
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
        "/all-applications",
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

            const applications = await findAllApplications();

            return applications;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[applicationsRouter] all-applications", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get All Applications",
            description: `Get All Applications. If the user is not a GCA, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/applications-without-master-key",
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

            const applications = await findAllApplicationsWithoutMasterKey();

            return applications;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[applicationsRouter] applications-without-master-key",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get Applications assigned to GCA without master key",
            description: `Get Applications assigned to GCA without master key. If the user is not a GCA, it will throw an error.`,
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

            // Try to find an existing draft for this user
            const existingDraft = await findFirstApplicationDraftByUserId(
              userId
            );
            if (existingDraft) {
              return existingDraft.id;
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
      .get(
        "/user-encrypted-key-by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) throw new Error("application id is required");

          try {
            const application = await FindFirstApplicationById(applicationId);

            if (!application) {
              set.status = 400;
              return "Application not found";
            }

            if (application?.userId !== userId) {
              const gca = await FindFirstGcaById(userId);

              if (!gca) {
                const user = await findFirstUserById(userId);
                if (!user) {
                  set.status = 400;
                  return "Unauthorized";
                }

                const isAuthorized =
                  user.organizationUser?.hasDocumentsAccess ||
                  user.gcaDelegatedUser;

                if (!isAuthorized) {
                  set.status = 400;
                  return "Unauthorized";
                }
              } else {
                const res =
                  await findFirstApplicationMasterKeyByApplicationIdAndUserId(
                    gca.id,
                    applicationId
                  );
                return res?.encryptedMasterKey;
              }
            }
            console.log(userId, applicationId);

            const res =
              await findFirstApplicationMasterKeyByApplicationIdAndUserId(
                userId,
                applicationId
              );
            return res?.encryptedMasterKey;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[documentsRouter] /organization-delegated-encrypted-key-by-application-id",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary:
              "Get Organization Delegated Encrypted Key by Application ID",
            description: `Get organization delegated encrypted key by application id, it will throw an error if your are not a member of an organization with documents access`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/organization-delegated-encrypted-key-by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) throw new Error("application id is required");

          try {
            const userOrganizations = await findAllUserJoinedOrganizations(
              userId
            );

            if (userOrganizations.length === 0) {
              set.status = 400;
              return "Unauthorized";
            }
            const hasDocumentsAccessOrganizations = userOrganizations.filter(
              (organization) => organization.hasDocumentsAccess
            );

            const res =
              await findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId(
                hasDocumentsAccessOrganizations.map(
                  (organization) => organization.id
                ),
                applicationId
              );

            return res?.encryptedMasterKey;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[documentsRouter] /organization-delegated-encrypted-key-by-application-id",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary:
              "Get Organization Delegated Encrypted Key by Application ID",
            description: `Get organization delegated encrypted key by application id, it will throw an error if your are not a member of an organization with documents access`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/gca-delegated-user-encrypted-key-by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) throw new Error("application id is required");

          try {
            const gcaDelegatedUser = await findFirstDelegatedUserByUserId(
              userId
            );

            if (!gcaDelegatedUser) {
              set.status = 400;
              return "Unauthorized";
            }

            const res =
              await findFirstDelegatedEncryptedMasterKeyByApplicationId(
                gcaDelegatedUser.id,
                applicationId
              );

            return res?.encryptedMasterKey;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[documentsRouter] /gca-delegated-user-encrypted-key-by-application-id",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Get GCA Delegated User Encrypted Key by Application ID",
            description: `Get GCA delegated user encrypted key by application id, it will throw an error if your are not a GCA delegated user`,
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

            if (!existingApplication) {
              const gcaAddress = await roundRobinAssignement();
              const orgUsers =
                await findOrganizationsMemberByUserIdAndOrganizationIds(
                  body.organizationIds,
                  userId
                );

              if (orgUsers.length !== body.organizationIds.length) {
                set.status = 400;
                return "Unauthorized";
              }

              if (!body.declarationOfIntentionBody) {
                set.status = 400;
                return "Declaration of intention is required";
              }

              await createApplication(
                orgUsers,
                body.latestUtilityBill.publicUrl,
                body.applicationEncryptedMasterKeys,
                {
                  id: body.applicationId,
                  userId,
                  zoneId: body.zoneId,
                  farmId: null,
                  createdAt: new Date(),
                  currentStep: 1,
                  gcaAssignedTimestamp: new Date(),
                  gcaAddress,
                  roundRobinStatus: RoundRobinStatusEnum.waitingToBeAccepted,
                  status: ApplicationStatusEnum.waitingForApproval,
                },
                {
                  applicationId: body.applicationId,
                  address: body.address,
                  farmOwnerName: body.farmOwnerName,
                  farmOwnerEmail: body.farmOwnerEmail,
                  farmOwnerPhone: body.farmOwnerPhone,
                  estimatedCostOfPowerPerKWh:
                    body.estimatedCostOfPowerPerKWh.toString(),
                  estimatedKWhGeneratedPerYear:
                    body.estimatedKWhGeneratedPerYear.toString(),
                  enquiryEstimatedFees: body.enquiryEstimatedFees.toString(),
                  enquiryEstimatedQuotePerWatt:
                    body.enquiryEstimatedQuotePerWatt.toString(),
                  installerName: body.installerName,
                  installerCompanyName: body.installerCompanyName,
                  installerEmail: body.installerEmail,
                  installerPhone: body.installerPhone,
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                },
                {
                  declarationOfIntention:
                    body.declarationOfIntentionBody.declarationOfIntention,
                  declarationOfIntentionSignature:
                    body.declarationOfIntentionBody
                      .declarationOfIntentionSignature,
                  declarationOfIntentionFieldsValue:
                    body.declarationOfIntentionBody
                      .declarationOfIntentionFieldsValue,
                  declarationOfIntentionVersion:
                    body.declarationOfIntentionBody
                      .declarationOfIntentionVersion,
                }
              );
              if (process.env.NODE_ENV === "production") {
                const emitter = createGlowEventEmitter({
                  username: process.env.RABBITMQ_ADMIN_USER!,
                  password: process.env.RABBITMQ_ADMIN_PASSWORD!,
                  zoneId: 1,
                });

                emitter
                  .emit({
                    eventType: eventTypes.applicationCreated,
                    schemaVersion: "v1",
                    payload: {
                      gcaAddress,
                      lat: body.lat,
                      lng: body.lng,
                      estimatedCostOfPowerPerKWh:
                        body.estimatedCostOfPowerPerKWh,
                      estimatedKWhGeneratedPerYear:
                        body.estimatedKWhGeneratedPerYear,
                      installerCompanyName: body.installerCompanyName,
                    },
                  })
                  .catch((e) => {
                    console.error("error with application.created event", e);
                  });
              }
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
            let protocolFeeData:
              | GetProtocolFeePaymentFromTxHashReceipt
              | undefined;
            const application = await FindFirstApplicationById(
              body.applicationId
            );

            const usedTxHash = await findUsedTxHash(body.txHash);

            if (usedTxHash) {
              set.status = 400;
              return "Transaction hash already been used";
            }

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
              protocolFeeData = await getProtocolFeePaymentFromTxHashReceipt(
                body.txHash
              );
              //TODO: handle additionalPaymentTxHash + verify if wallets are allowed to pay for additionalPaymentTxHash wallets

              if (
                protocolFeeData.user.id.toLowerCase() !== userId.toLowerCase()
              ) {
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
                  .map((c) => c.userId.toLowerCase());

                if (
                  !allowedWallets.includes(
                    protocolFeeData.user.id.toLowerCase()
                  )
                ) {
                  set.status = 400;
                  return "The transaction hash does not belong to the user or any of the organization members allowed to pay the protocol fee";
                }
              }

              if (
                BigInt(
                  ethers.utils
                    .parseUnits(application.finalProtocolFee, 6)
                    .toString()
                ) === BigInt(0)
              ) {
                set.status = 400;
                return "Final Protocol Fee is not set";
              }

              /// TODO: If it's greater, need to check with david what to do on that. For now, let's not change anything
              if (
                BigInt(protocolFeeData.amount) <
                BigInt(
                  ethers.utils
                    .parseUnits(application.finalProtocolFee, 6)
                    .toString()
                )
              ) {
                set.status = 400;
                return "Invalid Amount";
              }
              const emitter = createGlowEventEmitter({
                username: process.env.RABBITMQ_ADMIN_USER!,
                password: process.env.RABBITMQ_ADMIN_PASSWORD!,
                zoneId: 1,
              });

              emitter
                .emit({
                  eventType: eventTypes.auditPfeesPaid,
                  schemaVersion: "v1",
                  payload: {
                    applicationId: body.applicationId,
                    payer: protocolFeeData.user.id,
                    amount_6Decimals: protocolFeeData.amount,
                    txHash: body.txHash,
                  },
                })
                .catch((e) => {
                  console.error("error with audit.pfees.paid event", e);
                });
            }

            await updateApplication(body.applicationId, {
              status: ApplicationStatusEnum.paymentConfirmed,
              paymentTxHash: body.txHash,
              paymentDate: protocolFeeData
                ? protocolFeeData.paymentDate
                : new Date(),
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
            additionalPaymentTxHash: t.Optional(t.Array(t.String())),
          }),
          detail: {
            summary: "Verify Payment",
            description: `Verify Payment and update the application status to paymentConfirmed`,
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
              set.status = 400;
              return "Ask for Changes is not allowed for this step.";
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

            if (!application.auditFields?.adjustedWeeklyCarbonCredits) {
              set.status = 400;
              return "Application is not completed, adjustedWeeklyCarbonCredits is not set";
            }

            const farmId =
              await handleCreateWithoutPIIDocumentsAndCompleteApplication(
                application,
                gcaId,
                body.signature,
                ApplicationSteps.payment,
                body.annotation,
                {
                  finalAuditReport: body.finalAuditReport,
                  ...body.withoutPIIdocuments,
                  miscDocuments: body.miscDocuments,
                  devices: body.devices,
                  applicationAuditFields: {
                    finalEnergyCost: body.finalEnergyCost,
                    solarPanelsQuantity: body.solarPanelsQuantity,
                    solarPanelsBrandAndModel: body.solarPanelsBrandAndModel,
                    solarPanelsWarranty: body.solarPanelsWarranty,
                    ptoObtainedDate: body.ptoObtainedDate,
                    locationWithoutPII: body.locationWithoutPII,
                    revisedInstallFinishedDate: body.revisedInstallFinishedDate,
                  },
                }
              );

            if (
              process.env.NODE_ENV === "production" &&
              typeof farmId === "string"
            ) {
              const emitter = createGlowEventEmitter({
                username: process.env.RABBITMQ_ADMIN_USER!,
                password: process.env.RABBITMQ_ADMIN_PASSWORD!,
                zoneId: 1,
              });
              const protocolFeeUSDPrice_6Decimals = BigNumber.from(
                application.finalProtocolFee
              ).toString();

              const expectedProduction_12Decimals = BigNumber.from(
                Math.floor(
                  Number(application.auditFields.adjustedWeeklyCarbonCredits) *
                    1e6
                )
              ) // convert to int, 6 decimals
                .mul(BigNumber.from("1000000")) // 6 -> 12 decimals
                .toString();
              emitter
                .emit({
                  eventType: eventTypes.auditPushed,
                  schemaVersion: "v1",
                  payload: {
                    farmId,
                    protocolFeeUSDPrice_6Decimals,
                    expectedProduction_12Decimals,
                    txHash: application.paymentTxHash,
                  },
                })
                .catch((e) => {
                  console.error("error with audit.pushed event", e);
                });
            }
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
            solarPanelsQuantity: t.Number({
              example: 10,
              minimum: 1,
            }),
            solarPanelsBrandAndModel: t.String({
              minLength: 1,
            }),
            solarPanelsWarranty: t.String({
              minLength: 1,
            }),
            finalEnergyCost: t.String({
              minLength: 1,
            }),
            ptoObtainedDate: t.Nullable(t.Date()),
            revisedInstallFinishedDate: t.Date(),
            locationWithoutPII: t.String({
              minLength: 1,
            }),
            zoneId: t.Number({
              minimum: 1,
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

              if (!body.weeklyProduction || !body.weeklyCarbonDebt) {
                set.status = 400;
                return "Missing required fields for weekly production and weekly carbon debt";
              }

              const netCarbonCreditEarningWeekly = (
                body.weeklyProduction?.adjustedWeeklyCarbonCredits -
                body.weeklyCarbonDebt?.weeklyTotalCarbonDebt
              ).toString();
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
                },
                {
                  applicationId: body.applicationId,
                  systemWattageOutput:
                    body.weeklyCarbonDebt?.convertToKW.toString(),
                  netCarbonCreditEarningWeekly,
                  weeklyTotalCarbonDebt:
                    body.weeklyCarbonDebt?.weeklyTotalCarbonDebt.toString(),
                  averageSunlightHoursPerDay:
                    body.weeklyProduction?.hoursOfSunlightPerDay.toString(),
                  adjustedWeeklyCarbonCredits:
                    body.weeklyProduction?.adjustedWeeklyCarbonCredits.toString(),
                }
              );

              // --- Insert into weeklyProduction and weeklyCarbonDebt ---
              try {
                await db
                  .insert(weeklyProduction)
                  .values({
                    applicationId: body.applicationId,
                    createdAt: new Date(),
                    powerOutputMWH:
                      body.weeklyProduction?.powerOutputMWH?.toString(),
                    hoursOfSunlightPerDay:
                      body.weeklyProduction?.hoursOfSunlightPerDay?.toString(),
                    carbonOffsetsPerMWH:
                      body.weeklyProduction?.carbonOffsetsPerMWH?.toString(),
                    adjustmentDueToUncertainty:
                      body.weeklyProduction?.adjustmentDueToUncertainty?.toString(),
                    weeklyPowerProductionMWh:
                      body.weeklyProduction?.weeklyPowerProductionMWh?.toString(),
                    weeklyCarbonCredits:
                      body.weeklyProduction?.weeklyCarbonCredits?.toString(),
                    adjustedWeeklyCarbonCredits:
                      body.weeklyProduction?.adjustedWeeklyCarbonCredits?.toString(),
                  } as any)
                  .onConflictDoUpdate({
                    target: [weeklyProduction.applicationId],
                    set: {
                      createdAt: new Date(),
                      powerOutputMWH:
                        body.weeklyProduction?.powerOutputMWH?.toString(),
                      hoursOfSunlightPerDay:
                        body.weeklyProduction?.hoursOfSunlightPerDay?.toString(),
                      carbonOffsetsPerMWH:
                        body.weeklyProduction?.carbonOffsetsPerMWH?.toString(),
                      adjustmentDueToUncertainty:
                        body.weeklyProduction?.adjustmentDueToUncertainty?.toString(),
                      weeklyPowerProductionMWh:
                        body.weeklyProduction?.weeklyPowerProductionMWh?.toString(),
                      weeklyCarbonCredits:
                        body.weeklyProduction?.weeklyCarbonCredits?.toString(),
                      adjustedWeeklyCarbonCredits:
                        body.weeklyProduction?.adjustedWeeklyCarbonCredits?.toString(),
                    },
                  });

                await db
                  .insert(weeklyCarbonDebt)
                  .values({
                    applicationId: body.applicationId,
                    createdAt: new Date(),
                    totalCarbonDebtAdjustedKWh:
                      body.weeklyCarbonDebt?.totalCarbonDebtAdjustedKWh?.toString(),
                    convertToKW: body.weeklyCarbonDebt?.convertToKW?.toString(),
                    totalCarbonDebtProduced:
                      body.weeklyCarbonDebt?.totalCarbonDebtProduced?.toString(),
                    disasterRisk:
                      body.weeklyCarbonDebt?.disasterRisk?.toString(),
                    commitmentPeriod:
                      body.weeklyCarbonDebt?.commitmentPeriod?.toString(),
                    adjustedTotalCarbonDebt:
                      body.weeklyCarbonDebt?.adjustedTotalCarbonDebt?.toString(),
                    weeklyTotalCarbonDebt:
                      body.weeklyCarbonDebt?.weeklyTotalCarbonDebt?.toString(),
                  } as any)
                  .onConflictDoUpdate({
                    target: [weeklyCarbonDebt.applicationId],
                    set: {
                      createdAt: new Date(),
                      totalCarbonDebtAdjustedKWh:
                        body.weeklyCarbonDebt?.totalCarbonDebtAdjustedKWh?.toString(),
                      convertToKW:
                        body.weeklyCarbonDebt?.convertToKW?.toString(),
                      totalCarbonDebtProduced:
                        body.weeklyCarbonDebt?.totalCarbonDebtProduced?.toString(),
                      disasterRisk:
                        body.weeklyCarbonDebt?.disasterRisk?.toString(),
                      commitmentPeriod: body.weeklyCarbonDebt?.commitmentPeriod,
                      adjustedTotalCarbonDebt:
                        body.weeklyCarbonDebt?.adjustedTotalCarbonDebt?.toString(),
                      weeklyTotalCarbonDebt:
                        body.weeklyCarbonDebt?.weeklyTotalCarbonDebt?.toString(),
                    },
                  });
              } catch (err) {
                set.status = 500;
                return `Failed to upsert weekly production or carbon debt: ${
                  err instanceof Error ? err.message : String(err)
                }`;
              }
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
            console.log(
              "[applicationsRouter] inspection-and-pto-approve-or-ask-for-changes",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            ...ApproveOrAskForChangesQueryBody,
            weeklyProduction: t.Nullable(t.Object(WeeklyProductionSchema)),
            weeklyCarbonDebt: t.Nullable(t.Object(WeeklyCarbonDebtSchema)),
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

            if (
              afterInstallVisitDate.getTime() <
              dayAfterInstallFinishedDate.getTime()
            ) {
              set.status = 400;
              return "Invalid date";
            }

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
      .post(
        "/create-application-encrypted-master-keys",
        async ({ body, set, userId: gcaId }) => {
          const account = await findFirstAccountById(gcaId);
          if (!account) {
            return { errorCode: 404, errorMessage: "Account not found" };
          }
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            await createApplicationEncryptedMasterKeysForUsers(
              body.applicationEncryptedMasterKeys.map((key) => ({
                ...key,
                applicationId: body.applicationId,
              }))
            );
            await updateApplication(body.applicationId, {
              isDocumentsCorrupted: body.isDocumentsCorrupted,
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[applicationsRouter] create-application-encrypted-master-keys",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            isDocumentsCorrupted: t.Boolean(),
            applicationEncryptedMasterKeys: t.Array(
              t.Object({
                publicKey: t.Optional(t.String()),
                userId: t.String(),
                encryptedMasterKey: t.String(),
              })
            ),
          }),
          detail: {
            summary: "Create Application Encrypted Master Keys",
            description: `Create Application Encrypted Master Keys. If the user is not a GCA, it will throw an error.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/patch-declaration-of-intention",
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

            if (application.declarationOfIntentionSignature) {
              set.status = 400;
              return "Declaration of intention already exists for this application";
            }

            await patchDeclarationOfIntention(
              application.id,
              body.declarationOfIntention,
              body.declarationOfIntentionSignature,
              body.declarationOfIntentionFieldsValue,
              body.declarationOfIntentionVersion
            );

            return { success: true };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[applicationsRouter] patch-declaration-of-intention",
              e
            );
            throw new Error("Error Occurred");
          }
        },
        {
          body: DeclarationOfIntentionMissingQueryBody,
          detail: {
            summary: "Patch missing declaration of intention",
            description:
              "Add declaration of intention to an application where it's missing",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/patch-production-and-carbon-debt",
        async ({ body, set, userId: gcaId }) => {
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

            if (account.role !== "GCA") {
              return {
                errorCode: 403,
                errorMessage: "Unauthorized",
              };
            }

            // Validate application exists
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return { error: "Application not found" };
            }

            if (application.status === ApplicationStatusEnum.completed) {
              return {
                errorCode: 400,
                errorMessage: "Application is already completed",
              };
            }

            if (application.gcaAddress !== account.id) {
              return {
                errorCode: 403,
                errorMessage:
                  "Unauthorized, you are not assigned to this application",
              };
            }

            const netCarbonCreditEarningWeekly = (
              Number(application.auditFields?.adjustedWeeklyCarbonCredits) -
              Number(application.auditFields?.weeklyTotalCarbonDebt)
            ).toString();

            await db.transaction(async (tx) => {
              await tx
                .insert(weeklyProduction)
                .values({
                  applicationId: body.applicationId,
                  createdAt: new Date(),
                  powerOutputMWH:
                    body.weeklyProduction.powerOutputMWH.toString(),
                  hoursOfSunlightPerDay:
                    body.weeklyProduction.hoursOfSunlightPerDay.toString(),
                  carbonOffsetsPerMWH:
                    body.weeklyProduction.carbonOffsetsPerMWH.toString(),
                  adjustmentDueToUncertainty:
                    body.weeklyProduction.adjustmentDueToUncertainty.toString(),
                  weeklyPowerProductionMWh:
                    body.weeklyProduction.weeklyPowerProductionMWh.toString(),
                  weeklyCarbonCredits:
                    body.weeklyProduction.weeklyCarbonCredits.toString(),
                  adjustedWeeklyCarbonCredits:
                    body.weeklyProduction.adjustedWeeklyCarbonCredits.toString(),
                } as any)
                .onConflictDoUpdate({
                  target: [weeklyProduction.applicationId],
                  set: {
                    createdAt: new Date(),
                    powerOutputMWH:
                      body.weeklyProduction.powerOutputMWH.toString(),
                    hoursOfSunlightPerDay:
                      body.weeklyProduction.hoursOfSunlightPerDay.toString(),
                    carbonOffsetsPerMWH:
                      body.weeklyProduction.carbonOffsetsPerMWH.toString(),
                    adjustmentDueToUncertainty:
                      body.weeklyProduction.adjustmentDueToUncertainty.toString(),
                    weeklyPowerProductionMWh:
                      body.weeklyProduction.weeklyPowerProductionMWh.toString(),
                    weeklyCarbonCredits:
                      body.weeklyProduction.weeklyCarbonCredits.toString(),
                    adjustedWeeklyCarbonCredits:
                      body.weeklyProduction.adjustedWeeklyCarbonCredits.toString(),
                  },
                });

              // Insert into weeklyCarbonDebt
              await tx
                .insert(weeklyCarbonDebt)
                .values({
                  applicationId: body.applicationId,
                  createdAt: new Date(),
                  totalCarbonDebtAdjustedKWh:
                    body.weeklyCarbonDebt.totalCarbonDebtAdjustedKWh.toString(),
                  convertToKW: body.weeklyCarbonDebt.convertToKW.toString(),
                  totalCarbonDebtProduced:
                    body.weeklyCarbonDebt.totalCarbonDebtProduced.toString(),
                  disasterRisk: body.weeklyCarbonDebt.disasterRisk.toString(),
                  commitmentPeriod:
                    body.weeklyCarbonDebt.commitmentPeriod.toString(),
                  adjustedTotalCarbonDebt:
                    body.weeklyCarbonDebt.adjustedTotalCarbonDebt.toString(),
                  weeklyTotalCarbonDebt:
                    body.weeklyCarbonDebt.weeklyTotalCarbonDebt.toString(),
                } as any)
                .onConflictDoUpdate({
                  target: [weeklyCarbonDebt.applicationId],
                  set: {
                    createdAt: new Date(),
                    totalCarbonDebtAdjustedKWh:
                      body.weeklyCarbonDebt.totalCarbonDebtAdjustedKWh.toString(),
                    convertToKW: body.weeklyCarbonDebt.convertToKW.toString(),
                    totalCarbonDebtProduced:
                      body.weeklyCarbonDebt.totalCarbonDebtProduced.toString(),
                    disasterRisk: body.weeklyCarbonDebt.disasterRisk.toString(),
                    commitmentPeriod: body.weeklyCarbonDebt.commitmentPeriod,
                    adjustedTotalCarbonDebt:
                      body.weeklyCarbonDebt.adjustedTotalCarbonDebt.toString(),
                    weeklyTotalCarbonDebt:
                      body.weeklyCarbonDebt.weeklyTotalCarbonDebt.toString(),
                  },
                });

              // Update application with the specified fields
              await updateApplicationCRSFields(
                body.applicationId,
                {
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                },
                {
                  systemWattageOutput:
                    body.weeklyCarbonDebt.convertToKW.toString(),
                  netCarbonCreditEarningWeekly:
                    netCarbonCreditEarningWeekly.toString(),
                  weeklyTotalCarbonDebt:
                    body.weeklyCarbonDebt.weeklyTotalCarbonDebt.toString(),
                  averageSunlightHoursPerDay:
                    body.weeklyProduction.hoursOfSunlightPerDay.toString(),
                  adjustedWeeklyCarbonCredits:
                    body.weeklyProduction.adjustedWeeklyCarbonCredits.toString(),
                }
              );
            });

            return { success: true };
          } catch (e) {
            set.status = 500;
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            weeklyProduction: t.Object(WeeklyProductionSchema),
            weeklyCarbonDebt: t.Object(WeeklyCarbonDebtSchema),
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
          }),
          detail: {
            summary: "Patch production and carbon debt for an application",
            description:
              "Update application with systemWattageOutput, netCarbonCreditEarningWeekly, weeklyTotalCarbonDebt, averageSunlightHoursPerDay, lat, lng and insert weeklyProduction and weeklyCarbonDebt records.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
