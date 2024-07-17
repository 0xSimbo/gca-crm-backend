import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllDocumentsByApplicationId } from "../../db/queries/documents/findAllDocumentsByApplicationId";
import { findFirstDocumentById } from "../../db/queries/documents/findFirstDocumentById";
import { updateDocumentWithAnnotation } from "../../db/mutations/documents/updateDocumentWithAnnotation";
import { findAllDocumentsByStep } from "../../db/queries/documents/findAllDocumentsByStep";
import { PermissionsEnum } from "../../types/api-types/Permissions";
import { findFirstOrganizationApplicationByApplicationId } from "../../db/queries/applications/findFirstOrganizationApplicationByApplicationId";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { findAllApplicationsByOrganizationId } from "../../db/queries/applications/findAllApplicationsByOrganizationId";
import { findOrganizationById } from "../../db/queries/organizations/findOrganizationById";
import { findAllEncryptedDocumentsByApplicationsIds } from "../../db/queries/documents/findAllEncryptedDocumentsByApplicationsIds";
import { findFirstDelegatedUserByUserId } from "../../db/queries/gcaDelegatedUsers/findFirstDelegatedUserByUserId";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";
import { findAllApplicationsAssignedToGca } from "../../db/queries/applications/findAllApplicationsAssignedToGca";

export const documentsRouter = new Elysia({ prefix: "/documents" })
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
            const document = await findFirstDocumentById(query.id);
            if (!document) {
              set.status = 404;
              throw new Error("Document not found");
            }
            if (document.application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                const organizationApplication =
                  await findFirstOrganizationApplicationByApplicationId(
                    document.application.id
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
                  isOrganizationOwner || organizationMember?.hasDocumentsAccess;

                if (!isAuthorized) {
                  set.status = 400;
                  return "Unauthorized";
                }
              }
            }
            return document;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] byId", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Get Document by ID",
            description: `Get Document by ID and check if the document is owned by the user, if not, it will throw an error if you are not an admin or GCA`,
            tags: [TAG.DOCUMENTS],
          },
        }
      )
      .get(
        "/all-by-application-id",
        async ({ query: { id }, set, userId }) => {
          if (!id) throw new Error("applicationId is required");
          try {
            const application = await FindFirstApplicationById(id);

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application?.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                const organizationApplication =
                  await findFirstOrganizationApplicationByApplicationId(
                    application.id
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

                  const isAuthorized =
                    isOrganizationOwner ||
                    organizationMember?.hasDocumentsAccess;

                  if (!isAuthorized) {
                    set.status = 400;
                    return "Unauthorized";
                  }
                }
              }
            }
            const documents = await findAllDocumentsByApplicationId(id);

            return documents;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] /all-by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Get All Documents by Application ID",
            description: `Get all documents by application, if application is not owned by user, it will throw an error if your are not an admin or GCA`,
            tags: [TAG.DOCUMENTS],
          },
        }
      )
      .get(
        "/all-organization-shared-encrypted-documents",
        async ({ query: { applicationId, organizationId }, set, userId }) => {
          if (!organizationId) throw new Error("organizationId is required");
          try {
            const organization = await findOrganizationById(organizationId);

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }

            const isOrganizationOwner = organization.ownerId === userId;

            const organizationMember = await findOrganizationMemberByUserId(
              organizationId,
              userId
            );

            const isAuthorized =
              isOrganizationOwner ||
              organizationMember?.hasDocumentsAccess ||
              organizationMember?.role?.rolePermissions.some(
                ({ permission }) =>
                  permission.key === PermissionsEnum.ApplicationsShare
              );

            if (!isAuthorized) {
              set.status = 400;
              return "Unauthorized";
            }
            console.log("applicationId", applicationId);
            if (applicationId && applicationId !== "undefined") {
              const documents =
                await findAllEncryptedDocumentsByApplicationsIds([
                  applicationId,
                ]);
              console.log({ documents });
              return documents;
            }

            const applications = await findAllApplicationsByOrganizationId(
              organizationId
            );

            if (applications.length === 0) {
              return [];
            }

            const documents = await findAllEncryptedDocumentsByApplicationsIds(
              applications.map((application) => application.id)
            );

            return documents;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[documentsRouter] /all-organization-shared-encrypted-documents",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            organizationId: t.String(),
            applicationId: t.Optional(t.String()),
          }),
          detail: {
            summary: "Get All Organization Shared Encrypted Documents",
            description: `Get all organization shared encrypted documents, it will throw an error if your are not the organization owner or have access to documents`,
            tags: [TAG.DOCUMENTS],
          },
        }
      )
      .get(
        "/all-encrypted-documents",
        async ({ set, userId: gcaId }) => {
          const gca = await FindFirstGcaById(gcaId);

          if (!gca) {
            set.status = 404;
            return "GCA not found";
          }

          try {
            const applications = await findAllApplicationsAssignedToGca(gcaId);

            if (applications.length === 0) {
              return [];
            }

            const documents = await findAllEncryptedDocumentsByApplicationsIds(
              applications.map((application) => application.id)
            );

            return documents;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] /all-encrypted-documents", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get All Encrypted Documents",
            description: `Get all encrypted documents, it will throw an error if your are not a gca`,
            tags: [TAG.DOCUMENTS],
          },
        }
      )
      .get(
        "/all-application-documents-by-step-index",
        async ({ query: { stepIndex, applicationId }, set, userId }) => {
          if (!stepIndex || !applicationId)
            throw new Error("stepIndex and applicationId is required");
          try {
            const application = await FindFirstApplicationById(applicationId);
            if (application?.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 400;

                return "Unauthorized";
              }
            }

            const documents = await findAllDocumentsByStep(
              stepIndex,
              applicationId
            );

            return documents;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] /all-by-step-index", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
            stepIndex: t.Numeric(),
          }),
          detail: {
            summary: "Get All Documents by Step Index",
            description: `Get all documents by Step Index, it will throw an error if your are not an admin or GCA`,
            tags: [TAG.DOCUMENTS],
          },
        }
      )
      .post(
        "/annotation",
        async ({ body, set, userId }) => {
          try {
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }
            if (account.role !== "GCA") {
              set.status = 400;
              return "You are not a GCA";
            }

            const document = await findFirstDocumentById(body.documentId);

            if (!document) {
              set.status = 404;
              return "Document not found";
            }

            const application = await FindFirstApplicationById(
              document.applicationId
            );

            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            if (application.currentStep > document.step) {
              set.status = 400;
              return "You can't update annotation on previous step";
            }

            if (application.gcaAddress !== account.id) {
              set.status = 400;
              return "You are not the GCA assigned to this application";
            }

            await updateDocumentWithAnnotation(
              body.annotation,
              body.documentId
            );
            return body.documentId;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] annotation", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            documentId: t.String(),
            annotation: t.String(),
          }),
          detail: {
            summary: "Create or Update an Application",
            description: `Create an Application`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
