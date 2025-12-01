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
import { applicationCompletedWithPaymentV2Types } from "../../constants/typed-data/step-approval";

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

import { handleCreateWithoutPIIDocumentsAndCompleteApplicationAudit } from "./steps/gca-application-audit-completion";
import { db } from "../../db/db";
import {
  OrganizationUsers,
  applicationsDraft,
  zones,
  fractions,
  ApplicationPriceQuotes,
} from "../../db/schema";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { PermissionsEnum } from "../../types/api-types/Permissions";
import { findFirstOrganizationApplicationByApplicationId } from "../../db/queries/applications/findFirstOrganizationApplicationByApplicationId";
import { findFirstDelegatedUserByUserId } from "../../db/queries/gcaDelegatedUsers/findFirstDelegatedUserByUserId";
import { findAllUserJoinedOrganizations } from "../../db/queries/organizations/findAllUserJoinedOrganizations";
import { findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId } from "../../db/queries/organizations/findFirstDelegatedEncryptedMasterKeyByApplicationIdAndOrganizationUserId";
import { findFirstDelegatedEncryptedMasterKeyByApplicationId } from "../../db/queries/organizations/findFirstDelegatedEncryptedMasterKeyByApplicationId";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";
import { findFirstApplicationMasterKeyByApplicationIdAndUserId } from "../../db/queries/applications/findFirstApplicationMasterKeyByApplicationIdAndUserId";
import { findAllApplicationsWithoutMasterKey } from "../../db/queries/applications/findAllApplicationsWithoutMasterKey";
import { createApplicationEncryptedMasterKeysForUsers } from "../../db/mutations/applications/createApplicationEncryptedMasterKeysForUsers";
import { findAllApplications } from "../../db/queries/applications/findAllApplications";
import { eq, and, not, desc } from "drizzle-orm";
import { findOrganizationsMemberByUserIdAndOrganizationIds } from "../../db/queries/organizations/findOrganizationsMemberByUserIdAndOrganizationIds";
import { patchDeclarationOfIntention } from "../../db/mutations/applications/patchDeclarationOfIntention";
import { createGlowEventEmitter, eventTypes } from "@glowlabs-org/events-sdk";
import {
  EnquiryQueryBody,
  DeclarationOfIntentionMissingQueryBody,
  PreInstallDocumentsQueryBody,
  InspectionAndPTOQueryBody,
  GcaAcceptApplicationQueryBody,
  ApproveOrAskForChangesQueryBody,
} from "./query-schemas";
import { findFirstApplicationDraftByUserId } from "../../db/queries/applications/findFirstApplicationDraftByUserId";
import { publicApplicationsRoutes } from "./publicRoutes";
import { approveOrAskRoutes } from "./approveOrAskRoutes";
import { organizationApplicationRoutes } from "./organizationApplicationRoutes";
import { findProjectQuotesByUserId } from "../../db/queries/project-quotes/findProjectQuotesByUserId";
import { findProjectQuoteById } from "../../db/queries/project-quotes/findProjectQuoteById";
import { forwarderAddresses } from "../../constants/addresses";
import { extractElectricityPriceFromUtilityBill } from "./helpers/extractElectricityPrice";
import { computeProjectQuote } from "./helpers/computeProjectQuote";
import { createProjectQuote } from "../../db/mutations/project-quotes/createProjectQuote";
import { countQuotesInLastHour } from "../../db/queries/project-quotes/countQuotesInLastHour";
import { getRegionCodeFromCoordinates } from "./helpers/mapStateToRegionCode";
import { parseUnits } from "viem";
import { updateQuoteCashAmount } from "../../db/mutations/project-quotes/updateQuoteCashAmount";
import { updateQuoteStatus } from "../../db/mutations/project-quotes/updateQuoteStatus";
import {
  createFraction,
  validateFractionCanBeModified,
  createSafeFractionUpdateWhere,
  markFractionAsExpired,
} from "../../db/mutations/fractions/createFraction";
import {
  findActiveFractionByApplicationId,
  findLatestFractionByApplicationId,
  getAllFractionsForApplication,
  getTotalRaisedForApplication,
} from "../../db/queries/fractions/findFractionsByApplicationId";
import {
  MIN_SPONSOR_SPLIT_PERCENT,
  MAX_SPONSOR_SPLIT_PERCENT,
  VALID_SPONSOR_SPLIT_PERCENTAGES,
  FRACTION_STATUS,
} from "../../constants/fractions";
import { findActiveDefaultMaxSplits } from "../../db/queries/defaultMaxSplits/findActiveDefaultMaxSplits";

export const applicationsRouter = new Elysia({ prefix: "/applications" })
  .use(publicApplicationsRoutes)
  .use(bearerplugin())
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .use(approveOrAskRoutes)
      .use(organizationApplicationRoutes)
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
                  estimatedAdjustedWeeklyCredits:
                    body.estimatedAdjustedWeeklyCredits.toString(),
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
                //TODO: update eventEmitter to not have a zoneId here
                const emitter = createGlowEventEmitter({
                  username: process.env.RABBITMQ_ADMIN_USER!,
                  password: process.env.RABBITMQ_ADMIN_PASSWORD!,
                  zoneId: 1,
                });

                const estimatedProtocolFeeUSDPrice_6Decimals = parseUnits(
                  body.enquiryEstimatedFees.toString(),
                  6
                );

                emitter
                  .emit({
                    eventType: eventTypes.applicationCreated,
                    schemaVersion: "v2-alpha",
                    payload: {
                      gcaAddress,
                      lat: body.lat,
                      lng: body.lng,
                      estimatedCostOfPowerPerKWh:
                        body.estimatedCostOfPowerPerKWh,
                      estimatedKWhGeneratedPerYear:
                        body.estimatedKWhGeneratedPerYear,
                      estimatedProtocolFeeUSDPrice_6Decimals:
                        estimatedProtocolFeeUSDPrice_6Decimals.toString(),
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
                  estimatedAdjustedWeeklyCredits:
                    body.estimatedAdjustedWeeklyCredits.toString(),
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

            //zoneId 1 is the global zone
            if (
              !application.allowedZones.includes(body.zoneId) &&
              body.zoneId !== 1
            ) {
              set.status = 400;
              return "Zone not allowed";
            }

            if (!application.auditFeesTxHash) {
              set.status = 400;
              return "Audit fees payment is not completed";
            }

            const zone = await db.query.zones.findFirst({
              where: eq(zones.id, body.zoneId),
            });

            if (!zone) {
              set.status = 400;
              return "Zone not found";
            }

            await handleCreateOrUpdatePreIntallDocuments(
              application,
              ApplicationSteps.preInstallDocuments,
              {
                ...body,
              },
              {
                installerCompanyName: body.installerCompanyName,
                installerEmail: body.installerEmail,
                installerPhone: body.installerPhone,
                installerName: body.installerName,
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
        "/gca-complete-audit",
        async ({ body, set, userId }) => {
          const gcaId = userId;
          try {
            const account = await findFirstAccountById(gcaId);
            if (!account) {
              return { errorCode: 404, errorMessage: "Account not found" };
            }

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

            if (!application.finalProtocolFee) {
              set.status = 400;
              return "No final protocol fee has been set yet";
            }

            if (!application.afterInstallVisitDate) {
              set.status = 400;
              return "After Install Visit Date is not set";
            }

            // build V2 payload with canonical JSON (sorted keys)
            const sortedEntries = (
              Object.entries(
                body.pricePerAssets as Record<string, string>
              ) as Array<[string, string]>
            ).sort(([a], [b]) => a.localeCompare(b));
            const canonicalPricesJson = JSON.stringify(
              Object.fromEntries(sortedEntries)
            );

            const signedValues = {
              applicationId: body.applicationId,
              deadline: body.deadline,
              devices: body.devices.map(
                (d: { publicKey: string }) => d.publicKey
              ),
              pricePerAssetsJson: canonicalPricesJson,
              typesVersion: "v2",
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            let recoveredAddress = await recoverAddressHandler(
              applicationCompletedWithPaymentV2Types,
              signedValues,
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

            await handleCreateWithoutPIIDocumentsAndCompleteApplicationAudit(
              application,
              gcaId,
              body.signature,
              canonicalPricesJson,
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
                  averageSunlightHoursPerDay: body.averageSunlightHoursPerDay,
                  adjustedWeeklyCarbonCredits: body.adjustedWeeklyCarbonCredits,
                  weeklyTotalCarbonDebt: body.weeklyTotalCarbonDebt,
                  netCarbonCreditEarningWeekly:
                    body.netCarbonCreditEarningWeekly,
                  systemWattageOutput: `${body.systemWattageOutput.replace(
                    " kW-DC | kW-AC",
                    ""
                  )} kW-DC`,
                },
              }
            );

            if (process.env.NODE_ENV === "production") {
              const emitter = createGlowEventEmitter({
                username: process.env.RABBITMQ_ADMIN_USER!,
                password: process.env.RABBITMQ_ADMIN_PASSWORD!,
                zoneId: application.zoneId,
              });
              const protocolFeeUSDPrice_6Decimals = BigInt(
                application.finalProtocolFee
              ).toString();

              const expectedProduction_12Decimals = BigInt(
                Math.trunc(Number(body.netCarbonCreditEarningWeekly) * 1e12)
              ).toString();
              emitter
                .emit({
                  eventType: eventTypes.auditPushed,
                  schemaVersion: "v2-alpha",
                  payload: {
                    applicationId: application.id,
                    protocolFeeUSDPrice_6Decimals,
                    expectedProduction_12Decimals,
                  },
                })
                .catch((e) => {
                  console.error("error with audit.pushed event", e);
                });
              emitter
                .emit({
                  eventType: eventTypes.applicationPriceQuote,
                  schemaVersion: "v2-alpha",
                  payload: {
                    applicationId: application.id,
                    gcaAddress: gcaId,
                    createdAt: new Date().toISOString(),
                    prices: body.pricePerAssets,
                    signature: body.signature,
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
                isShowingSolarPanels: t.Boolean(),
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
            pricePerAssets: t.Object({
              USDC: t.String({
                minLength: 1, // in bigint 6 decimals
              }),
              USDG: t.String({
                minLength: 1, // in bigint 6 decimals
              }),
              GCTL: t.String({
                minLength: 1, // in bigint 6 decimals
              }),
              GLW: t.String({
                minLength: 1, // in bigint 6 decimals
              }),
            }),
            // Added: auditor sheet numeric strings
            averageSunlightHoursPerDay: t.String(),
            adjustedWeeklyCarbonCredits: t.String(),
            weeklyTotalCarbonDebt: t.String(),
            netCarbonCreditEarningWeekly: t.String(),
            systemWattageOutput: t.String(),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/gca-pre-install-visit",
        async ({ body, set, userId }) => {
          const gcaId = userId;
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
        async ({ body, set, userId }) => {
          const gcaId = userId;
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
        async ({ body, set, userId }) => {
          const gcaId = userId;
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
              body.applicationEncryptedMasterKeys.map(
                (key: {
                  publicKey?: string;
                  userId: string;
                  encryptedMasterKey: string;
                }) => ({
                  ...key,
                  applicationId: body.applicationId,
                })
              )
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
        async ({ body, set, userId }) => {
          const gcaId = userId;
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

            await db.transaction(async (tx) => {
              await updateApplicationCRSFields(
                body.applicationId,
                {
                  lat: body.lat.toString(),
                  lng: body.lng.toString(),
                },
                {}
              );
            });
            //TODO: do i need to pass second arg here?

            return { success: true };
          } catch (e) {
            set.status = 500;
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            lat: t.Numeric({ example: 38.234242, minimum: -90, maximum: 90 }),
            lng: t.Numeric({
              example: -111.123412,
              minimum: -180,
              maximum: 180,
            }),
            // audit sheet values to persist into applicationsAuditFieldsCRS
            averageSunlightHoursPerDay: t.String(),
            adjustedWeeklyCarbonCredits: t.String(),
            weeklyTotalCarbonDebt: t.String(),
            netCarbonCreditEarningWeekly: t.String(),
            systemWattageOutput: t.Optional(t.String()), //TODO: why optional?
          }),
          detail: {
            summary: "Patch application location",
            description:
              "Update application lat/lng and rely on auditFields for production/debt values.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/publish-application-to-auction",
        async ({
          body: {
            applicationId,
            sponsorSplitPercent,
            stepPrice,
            rewardScore,
            totalSteps,
          },
          set,
          userId,
        }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 400;
              return "Unauthorized";
            }

            const application = await FindFirstApplicationById(applicationId);

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application.userId !== userId) {
              set.status = 400;
              return "User is not the owner of the application";
            }

            if (application.currentStep !== ApplicationSteps.payment) {
              set.status = 400;
              return "Application is not in the correct step";
            }

            if (
              !Number.isInteger(sponsorSplitPercent) ||
              !VALID_SPONSOR_SPLIT_PERCENTAGES.includes(sponsorSplitPercent)
            ) {
              set.status = 400;
              return `Invalid sponsorSplitPercent. Allowed values: ${VALID_SPONSOR_SPLIT_PERCENTAGES.join(
                ","
              )}`;
            }

            // Determine the effective maxSplits value
            let effectiveMaxSplits = application.maxSplits;
            if (!effectiveMaxSplits || effectiveMaxSplits === "0") {
              // Get the default maxSplits if application doesn't have a custom value
              const defaultMaxSplitsResult = await findActiveDefaultMaxSplits();
              if (defaultMaxSplitsResult.length > 0) {
                effectiveMaxSplits =
                  defaultMaxSplitsResult[0].maxSplits.toString();
              } else {
                throw new Error("No default maxSplits found");
              }
            }

            // Check if there's an existing active fraction for this application
            const latestFraction = await findLatestFractionByApplicationId(
              application.id
            );

            // Check if the existing fraction is expired and mark it as expired
            if (latestFraction && latestFraction.expirationAt < new Date()) {
              console.log(
                `[publish-application-to-auction] Marking expired fraction as expired: ${latestFraction.id}`
              );
              await markFractionAsExpired(latestFraction.id);
            }

            // CRITICAL: Auto-expire any active launchpad-presale fractions when creating GLW fraction
            // This prevents race conditions and ensures presale fractions are properly closed
            const presaleFractions = await getAllFractionsForApplication(
              application.id
            );

            // CRITICAL: Validate sponsorSplitPercent matches any existing presale fractions
            // This ensures consistent sponsor terms across all fractions for the same application
            const presaleWithSales = presaleFractions.find(
              (f) =>
                f.type === "launchpad-presale" &&
                f.splitsSold !== null &&
                f.splitsSold > 0
            );

            if (presaleWithSales) {
              if (
                presaleWithSales.sponsorSplitPercent !== sponsorSplitPercent
              ) {
                set.status = 400;
                return `Sponsor split percentage must match the presale fraction (${presaleWithSales.sponsorSplitPercent}%). You provided ${sponsorSplitPercent}%.`;
              }
            }

            for (const presaleFraction of presaleFractions) {
              if (
                presaleFraction.type === "launchpad-presale" &&
                presaleFraction.status === FRACTION_STATUS.COMMITTED &&
                presaleFraction.expirationAt >= new Date()
              ) {
                console.log(
                  `[publish-application-to-auction] Auto-expiring active presale fraction: ${presaleFraction.id}`
                );
                await markFractionAsExpired(presaleFraction.id);
              }
            }

            // CRITICAL: Validate that new GLW fraction amount covers exactly the remaining deficit
            // This prevents over-funding or under-funding the protocol deposit
            const { totalRaisedUSD } = await getTotalRaisedForApplication(
              application.id
            );
            const requiredProtocolFee = BigInt(
              application.finalProtocolFeeBigInt
            );
            const remainingDeficit = requiredProtocolFee - totalRaisedUSD;

            // Calculate USD value of the new GLW fraction using price quotes
            const stepPriceBigInt = BigInt(stepPrice);
            const totalStepsBigInt = BigInt(totalSteps);
            const newFractionTotalGLW = stepPriceBigInt * totalStepsBigInt;

            // Get price quotes to convert GLW to USD
            const priceQuotes = await db
              .select()
              .from(ApplicationPriceQuotes)
              .where(eq(ApplicationPriceQuotes.applicationId, application.id))
              .orderBy(desc(ApplicationPriceQuotes.createdAt))
              .limit(1);

            const prices = priceQuotes[0]?.prices || {};
            const glwPriceUSD6 = prices["GLW"] ? BigInt(prices["GLW"]) : null;

            if (!glwPriceUSD6) {
              set.status = 400;
              return "Cannot create GLW fraction: no GLW price quote found. Please ensure price quotes are set for this application.";
            }

            // Convert GLW amount to USD (6 decimals)
            // Formula: (GLW_amount * GLW_price_usd6) / 1e18
            const newFractionUSD =
              (newFractionTotalGLW * glwPriceUSD6) / BigInt(10) ** BigInt(18);

            // Strict validation: new fraction must equal remaining deficit
            const tolerance = BigInt(1000); // Allow 0.001 USD difference due to rounding
            const difference =
              newFractionUSD > remainingDeficit
                ? newFractionUSD - remainingDeficit
                : remainingDeficit - newFractionUSD;

            if (difference > tolerance) {
              set.status = 400;
              return `GLW fraction amount mismatch. Required: $${(
                Number(remainingDeficit) / 1e6
              ).toFixed(6)}, but this fraction will raise: $${(
                Number(newFractionUSD) / 1e6
              ).toFixed(
                6
              )}. Please adjust totalSteps or stepPrice to match the remaining deficit exactly.`;
            }

            console.log(
              `[publish-application-to-auction] Creating GLW fraction. Already raised: ${totalRaisedUSD.toString()} (${(
                Number(totalRaisedUSD) / 1e6
              ).toFixed(
                2
              )} USD), Required: ${requiredProtocolFee.toString()} (${(
                Number(requiredProtocolFee) / 1e6
              ).toFixed(
                2
              )} USD), This fraction: ${newFractionUSD.toString()} (${(
                Number(newFractionUSD) / 1e6
              ).toFixed(2)} USD)`
            );

            const activeFraction = await findActiveFractionByApplicationId(
              application.id
            );

            if (activeFraction) {
              // CRITICAL: Prevent any modification of filled fractions
              if (
                activeFraction.isFilled ||
                activeFraction.status === FRACTION_STATUS.FILLED
              ) {
                set.status = 400;
                return `Cannot modify fraction: fraction is already filled and cannot be changed`;
              }

              // If there's an active fraction, don't allow reducing the sponsor split percentage
              if (sponsorSplitPercent <= activeFraction.sponsorSplitPercent) {
                set.status = 400;
                return `Cannot reduce sponsor split percentage below the current active fraction (${activeFraction.sponsorSplitPercent}%). Current attempt: ${sponsorSplitPercent}%`;
              }
            }

            // No need to update application fields anymore since we use fractions

            let fraction: any;
            await db.transaction(async (tx) => {
              // If there's an existing uncommitted fraction, update it; otherwise create a new one
              if (activeFraction && !activeFraction.isCommittedOnChain) {
                // CRITICAL: Double-check fraction can be modified before updating
                validateFractionCanBeModified(activeFraction);

                // Update the existing fraction with the new sponsor split percentage
                // Keep the same expirationAt to maintain the original 4-week deadline
                // Use safe update WHERE clause to ensure we never update filled fractions
                fraction = await tx
                  .update(fractions)
                  .set({
                    sponsorSplitPercent,
                    updatedAt: new Date(),
                    rewardScore,
                  })
                  .where(createSafeFractionUpdateWhere(activeFraction.id))
                  .returning();
                fraction = fraction[0];
              } else {
                // Create a new fraction entry for this application
                // Validate sponsor split percentage
                if (
                  !VALID_SPONSOR_SPLIT_PERCENTAGES.includes(sponsorSplitPercent)
                ) {
                  throw new Error(
                    `Invalid sponsor split percentage: ${sponsorSplitPercent}. Must be one of: ${VALID_SPONSOR_SPLIT_PERCENTAGES.join(
                      ", "
                    )}`
                  );
                }

                fraction = await createFraction(
                  {
                    applicationId: application.id,
                    createdBy: userId,
                    sponsorSplitPercent,
                    stepPrice,
                    totalSteps,
                    rewardScore,
                    type: "launchpad",
                  },
                  tx
                );
              }
            });

            if (!fraction) {
              console.error("Failed to create or update fraction", fraction);
              throw new Error("Failed to create or update fraction");
            }

            return {
              fractionId: fraction.id,
              applicationId: application.id,
              sponsorSplitPercent,
              nonce: fraction.nonce,
              expirationAt: fraction.expirationAt,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[applicationsRouter] /publish-application-to-auction",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            sponsorSplitPercent: t.Number({
              minimum: MIN_SPONSOR_SPLIT_PERCENT,
              maximum: MAX_SPONSOR_SPLIT_PERCENT,
            }),
            stepPrice: t.String({
              description: "Price per step in token decimals",
            }),
            totalSteps: t.Number({
              minimum: 1,
              description: "Total number of steps",
            }),
            rewardScore: t.Number({
              minimum: 1,
              description:
                "Reward score for launchpad fractions (e.g., 50, 100, 200)",
            }),
          }),
          detail: {
            summary: "Publish Application to auction",
            description: `Set sponsorSplitPercent (${MIN_SPONSOR_SPLIT_PERCENT}-${MAX_SPONSOR_SPLIT_PERCENT} inclusive, in 1% steps). If not yet published, also toggle isPublishedOnAuction and set publishedOnAuctionTimestamp. If already published, only updates sponsorSplitPercent and sponsorSplitUpdatedAt.`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/project-quotes",
        async ({ userId, set }) => {
          try {
            // Check if user is FOUNDATION_HUB_MANAGER - grant access to all quotes
            const isFoundationManager =
              userId.toLowerCase() ===
              forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase();

            if (isFoundationManager) {
              // Return all quotes for foundation manager
              const allQuotes = await db.query.ProjectQuotes.findMany({
                orderBy: (quotes, { desc }) => [desc(quotes.createdAt)],
              });
              return { quotes: allQuotes };
            }

            // Regular users: only their own quotes
            const quotes = await findProjectQuotesByUserId(userId);
            return { quotes };
          } catch (e) {
            if (e instanceof Error) {
              console.error("[applicationsRouter] /project-quotes error:", e);
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quotes unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          detail: {
            summary: "Get all project quotes linked to authenticated user",
            description:
              "Returns all quotes that were created by wallet addresses linked to this user account. FOUNDATION_HUB_MANAGER has access to all quotes. Accessible through user dashboard.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/project-quote/:id",
        async ({ params, set, userId }) => {
          try {
            const quote = await findProjectQuoteById(params.id);

            if (!quote) {
              set.status = 404;
              return { error: "Quote not found" };
            }

            // Check if user is FOUNDATION_HUB_MANAGER - grant access to all quotes
            const isFoundationManager =
              userId.toLowerCase() ===
              forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase();

            // Check if user owns this quote (case-insensitive comparison)
            if (!isFoundationManager) {
              if (
                !quote.userId ||
                quote.userId.toLowerCase() !== userId.toLowerCase()
              ) {
                set.status = 403;
                return {
                  error: "Access denied. You can only view your own quotes.",
                };
              }
            }

            // Return formatted quote
            return {
              quoteId: quote.id,
              createdAt: quote.createdAt,
              walletAddress: quote.walletAddress,
              userId: quote.userId,
              regionCode: quote.regionCode,
              location: {
                latitude: parseFloat(quote.latitude),
                longitude: parseFloat(quote.longitude),
              },
              inputs: {
                weeklyConsumptionMWh: parseFloat(quote.weeklyConsumptionMWh),
                systemSizeKw: parseFloat(quote.systemSizeKw),
              },
              protocolDeposit: {
                usd6Decimals: quote.protocolDepositUsd6,
                usd: parseFloat(quote.protocolDepositUsd6) / 1e6,
              },
              carbonMetrics: {
                weeklyCredits: parseFloat(quote.weeklyCredits),
                weeklyDebt: parseFloat(quote.weeklyDebt),
                netWeeklyCc: parseFloat(quote.netWeeklyCc),
                netCcPerMwh: parseFloat(quote.netCcPerMwh),
                carbonOffsetsPerMwh: parseFloat(quote.carbonOffsetsPerMwh),
                uncertaintyApplied: parseFloat(quote.uncertaintyApplied),
              },
              efficiency: {
                score: quote.efficiencyScore,
                weeklyImpactAssetsWad: quote.weeklyImpactAssetsWad,
              },
              rates: {
                discountRate: parseFloat(quote.discountRate),
                escalatorRate: parseFloat(quote.escalatorRate),
                commitmentYears: quote.years,
              },
              extraction: {
                electricityPricePerKwh: parseFloat(
                  quote.electricityPricePerKwh
                ),
                confidence: quote.priceConfidence
                  ? parseFloat(quote.priceConfidence)
                  : null,
                source: quote.priceSource,
                utilityBillUrl: quote.utilityBillUrl,
              },
              admin: {
                cashAmountUsd: quote.cashAmountUsd,
                status: quote.status,
              },
              debug: quote.debugJson,
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error(
                "[applicationsRouter] /project-quote/:id error:",
                e
              );
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote/:id unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          params: t.Object({
            id: t.String({ description: "Quote ID" }),
          }),
          detail: {
            summary: "Retrieve a project quote by ID (bearer auth)",
            description:
              "Returns the full quote details for quotes linked to the authenticated user's account. FOUNDATION_HUB_MANAGER has access to all quotes. Accessible through user dashboard with bearer token.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/project-quote/:id/cash-amount",
        async ({ params, body, set, userId }) => {
          try {
            // Check if user is FOUNDATION_HUB_MANAGER
            const isFoundationManager =
              userId.toLowerCase() ===
              forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase();

            if (!isFoundationManager) {
              set.status = 403;
              return {
                error: "Access denied. Only hub manager can set cash amount.",
              };
            }

            // Find quote
            const quote = await findProjectQuoteById(params.id);
            if (!quote) {
              set.status = 404;
              return { error: "Quote not found" };
            }

            // Update cash amount
            const updatedQuote = await updateQuoteCashAmount(
              params.id,
              body.cashAmountUsd
            );

            return {
              message: "Cash amount updated successfully",
              quote: {
                id: updatedQuote.id,
                cashAmountUsd: updatedQuote.cashAmountUsd,
              },
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error(
                "[applicationsRouter] /project-quote/:id/cash-amount error:",
                e
              );
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote/:id/cash-amount unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          params: t.Object({
            id: t.String({ description: "Quote ID" }),
          }),
          body: t.Object({
            cashAmountUsd: t.String({
              description: "Cash amount in USD (as string for precision)",
            }),
          }),
          detail: {
            summary: "Set cash amount for a quote (hub manager only)",
            description:
              "Allows FOUNDATION_HUB_MANAGER to set the validated cash amount for a project quote.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/project-quote/:id/approve",
        async ({ params, set, userId }) => {
          try {
            // Find quote
            const quote = await findProjectQuoteById(params.id);
            if (!quote) {
              set.status = 404;
              return { error: "Quote not found" };
            }

            // Check if user owns this quote
            if (
              !quote.userId ||
              quote.userId.toLowerCase() !== userId.toLowerCase()
            ) {
              set.status = 403;
              return {
                error: "Access denied. You can only approve your own quotes.",
              };
            }

            // Check current status - can only approve if pending
            if (quote.status !== "pending") {
              set.status = 400;
              return {
                error: `Cannot approve quote with status '${quote.status}'. Only pending quotes can be approved.`,
              };
            }

            // Check if hub manager has set cash amount
            if (!quote.cashAmountUsd) {
              set.status = 400;
              return {
                error:
                  "Cannot approve quote. Hub manager must set cash amount first.",
              };
            }

            // Update status to approved
            await updateQuoteStatus(params.id, "approved");

            return {
              message: "Quote approved successfully",
              quoteId: params.id,
              status: "approved",
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error(
                "[applicationsRouter] /project-quote/:id/approve error:",
                e
              );
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote/:id/approve unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          params: t.Object({
            id: t.String({ description: "Quote ID" }),
          }),
          detail: {
            summary: "Approve a project quote (owner only)",
            description:
              "Allows the quote owner to approve a pending quote. Hub manager must set cashAmountUsd before owner can approve. Only quotes with 'pending' status can be approved.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/project-quote/:id/reject",
        async ({ params, set, userId }) => {
          try {
            // Find quote
            const quote = await findProjectQuoteById(params.id);
            if (!quote) {
              set.status = 404;
              return { error: "Quote not found" };
            }

            // Check if user owns this quote
            if (
              !quote.userId ||
              quote.userId.toLowerCase() !== userId.toLowerCase()
            ) {
              set.status = 403;
              return {
                error: "Access denied. You can only reject your own quotes.",
              };
            }

            // Check current status - can only reject if pending
            if (quote.status !== "pending") {
              set.status = 400;
              return {
                error: `Cannot reject quote with status '${quote.status}'. Only pending quotes can be rejected.`,
              };
            }

            // Check if hub manager has set cash amount
            if (!quote.cashAmountUsd) {
              set.status = 400;
              return {
                error:
                  "Cannot reject quote. Hub manager must set cash amount first.",
              };
            }

            // Update status to rejected
            await updateQuoteStatus(params.id, "rejected");

            return {
              message: "Quote rejected successfully",
              quoteId: params.id,
              status: "rejected",
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error(
                "[applicationsRouter] /project-quote/:id/reject error:",
                e
              );
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote/:id/reject unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          params: t.Object({
            id: t.String({ description: "Quote ID" }),
          }),
          detail: {
            summary: "Reject a project quote (owner only)",
            description:
              "Allows the quote owner to reject a pending quote. Hub manager must set cashAmountUsd before owner can reject. Only quotes with 'pending' status can be rejected.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/project-quote/:id/cancel",
        async ({ params, set, userId }) => {
          try {
            // Find quote
            const quote = await findProjectQuoteById(params.id);
            if (!quote) {
              set.status = 404;
              return { error: "Quote not found" };
            }

            // Check if user is hub manager or owns this quote
            const isFoundationManager =
              userId.toLowerCase() ===
              forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase();

            const isOwner =
              quote.userId &&
              quote.userId.toLowerCase() === userId.toLowerCase();

            if (!isFoundationManager && !isOwner) {
              set.status = 403;
              return {
                error:
                  "Access denied. You can only cancel your own quotes or be a hub manager.",
              };
            }

            // Check current status - can only cancel if pending
            if (quote.status !== "pending") {
              set.status = 400;
              return {
                error: `Cannot cancel quote with status '${quote.status}'. Only pending quotes can be cancelled.`,
              };
            }

            // Update status to cancelled
            await updateQuoteStatus(params.id, "cancelled");

            return {
              message: "Quote cancelled successfully",
              quoteId: params.id,
              status: "cancelled",
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error(
                "[applicationsRouter] /project-quote/:id/cancel error:",
                e
              );
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote/:id/cancel unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          params: t.Object({
            id: t.String({ description: "Quote ID" }),
          }),
          detail: {
            summary: "Cancel a project quote (owner or hub manager)",
            description:
              "Allows the quote owner or FOUNDATION_HUB_MANAGER to cancel a pending quote. Only quotes with 'pending' status can be cancelled.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/project-quote",
        async ({ body, set, userId }) => {
          try {
            // Validate inputs
            const weeklyConsumptionMWh = parseFloat(body.weeklyConsumptionMWh);
            const systemSizeKw = parseFloat(body.systemSizeKw);
            const latitude = parseFloat(body.latitude);
            const longitude = parseFloat(body.longitude);

            if (isNaN(weeklyConsumptionMWh) || weeklyConsumptionMWh <= 0) {
              set.status = 400;
              return {
                error: "weeklyConsumptionMWh must be a positive number",
              };
            }

            if (isNaN(systemSizeKw) || systemSizeKw <= 0) {
              set.status = 400;
              return { error: "systemSizeKw must be a positive number" };
            }

            if (isNaN(latitude) || isNaN(longitude)) {
              set.status = 400;
              return { error: "latitude and longitude must be valid numbers" };
            }

            // Derive wallet address from authenticated userId
            const walletAddress = userId.toLowerCase();

            // Check global rate limit: 100 quotes per hour for all users
            const quoteCount = await countQuotesInLastHour();
            if (quoteCount >= 100) {
              set.status = 429;
              return {
                error:
                  "Rate limit exceeded. The system can process a maximum of 100 quotes per hour. Please try again later.",
              };
            }

            // Derive region code from coordinates
            const regionCode = await getRegionCodeFromCoordinates(
              latitude,
              longitude
            );
            if (!regionCode) {
              set.status = 400;
              return {
                error:
                  "Unable to determine region from the provided coordinates. Please ensure the location is within a supported region.",
              };
            }

            // Validate utility bill file
            if (!body.utilityBill) {
              set.status = 400;
              return { error: "utilityBill file is required" };
            }

            const file = body.utilityBill;

            // Only accept PDFs per the extraction methodology
            if (file.type !== "application/pdf") {
              set.status = 400;
              return {
                error:
                  "Only PDF utility bills are accepted. Please upload a PDF file.",
              };
            }

            // Max 10MB file size
            const maxSize = 10 * 1024 * 1024;
            if (file.size > maxSize) {
              set.status = 400;
              return { error: "File size must be less than 10MB" };
            }

            // Extract electricity price from utility bill
            const fileBuffer = Buffer.from(await file.arrayBuffer());
            const extracted = await extractElectricityPriceFromUtilityBill(
              fileBuffer,
              file.name,
              file.type
            );
            const priceExtraction = extracted.result;
            const billUrl = extracted.billUrl;

            // Compute quote
            const quoteResult = await computeProjectQuote({
              weeklyConsumptionMWh,
              systemSizeKw,
              electricityPricePerKwh: priceExtraction.pricePerKwh,
              latitude,
              longitude,
            });

            // Persist to database
            const savedQuote = await createProjectQuote({
              walletAddress,
              userId,
              metadata: body.metadata,
              regionCode,
              latitude: latitude.toString(),
              longitude: longitude.toString(),
              weeklyConsumptionMWh: weeklyConsumptionMWh.toString(),
              systemSizeKw: systemSizeKw.toString(),
              electricityPricePerKwh: priceExtraction.pricePerKwh.toString(),
              priceSource: "ai",
              priceConfidence: priceExtraction.confidence.toString(),
              utilityBillUrl: billUrl,
              discountRate: quoteResult.discountRate.toString(),
              escalatorRate: quoteResult.escalatorRate.toString(),
              years: quoteResult.years,
              protocolDepositUsd6: quoteResult.protocolDepositUsd6,
              weeklyCredits: quoteResult.weeklyCredits.toString(),
              weeklyDebt: quoteResult.weeklyDebt.toString(),
              netWeeklyCc: quoteResult.netWeeklyCc.toString(),
              netCcPerMwh: quoteResult.netCcPerMwh.toString(),
              weeklyImpactAssetsWad: quoteResult.weeklyImpactAssetsWad,
              efficiencyScore: quoteResult.efficiencyScore,
              carbonOffsetsPerMwh: quoteResult.carbonOffsetsPerMwh.toString(),
              uncertaintyApplied: quoteResult.uncertaintyApplied.toString(),
              debugJson: quoteResult.debugJson,
            });

            // Return response
            return {
              quoteId: savedQuote.id,
              walletAddress: savedQuote.walletAddress,
              userId: savedQuote.userId,
              metadata: savedQuote.metadata,
              regionCode: savedQuote.regionCode,
              protocolDeposit: {
                usd: quoteResult.protocolDepositUsd,
                usd6Decimals: quoteResult.protocolDepositUsd6,
              },
              carbonMetrics: {
                weeklyCredits: quoteResult.weeklyCredits,
                weeklyDebt: quoteResult.weeklyDebt,
                netWeeklyCc: quoteResult.netWeeklyCc,
                netCcPerMwh: quoteResult.netCcPerMwh,
                carbonOffsetsPerMwh: quoteResult.carbonOffsetsPerMwh,
                uncertaintyApplied: quoteResult.uncertaintyApplied,
              },
              efficiency: {
                score: quoteResult.efficiencyScore,
                weeklyImpactAssetsWad: quoteResult.weeklyImpactAssetsWad,
              },
              rates: {
                discountRate: quoteResult.discountRate,
                escalatorRate: quoteResult.escalatorRate,
                commitmentYears: quoteResult.years,
              },
              extraction: {
                electricityPricePerKwh: priceExtraction.pricePerKwh,
                confidence: priceExtraction.confidence,
                rationale: priceExtraction.rationale,
                utilityBillUrl: billUrl,
              },
              debug: quoteResult.debugJson,
            };
          } catch (e) {
            if (e instanceof Error) {
              console.error("[applicationsRouter] /project-quote error:", e);
              set.status = 400;
              return { error: e.message };
            }
            console.error(
              "[applicationsRouter] /project-quote unknown error:",
              e
            );
            set.status = 500;
            return { error: "Internal server error" };
          }
        },
        {
          body: t.Object({
            weeklyConsumptionMWh: t.String({
              description: "Weekly energy consumption in MWh (from Aurora)",
            }),
            systemSizeKw: t.String({
              description: "System size in kW (nameplate capacity)",
            }),
            latitude: t.String({
              description: "Latitude of the solar farm location",
            }),
            longitude: t.String({
              description: "Longitude of the solar farm location",
            }),
            utilityBill: t.File({
              description: "Utility bill PDF for price extraction",
            }),
            metadata: t.Optional(
              t.String({
                description:
                  "Optional metadata for identifying the quote (e.g., farm owner name, project ID)",
              })
            ),
          }),
          detail: {
            summary: "Create a project quote (hub frontend, bearer auth)",
            description:
              "Upload a utility bill, provide Aurora weekly consumption, system size, and location coordinates. Authenticated via bearer token (JWT). The region will be automatically determined from coordinates. Returns estimated protocol deposit, carbon metrics, and efficiency scores. Wallet address is derived from the authenticated user.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
