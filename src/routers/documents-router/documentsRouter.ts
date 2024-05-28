import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { GetEntityByIdPathParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";

import { findAllDocumentsByApplicationId } from "../../db/queries/documents/findAllDocumentsByApplicationId";
import { findFirstDocumentById } from "../../db/queries/documents/findFirstDocumentById";
import { updateDocumentWithAnnotation } from "../../db/mutations/documents/updateDocumentWithAnnotation";
import { updateDocumentKeysSets } from "../../db/mutations/documents/updateDocumentKeysSets";

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
                set.status = 403;
                return "Unauthorized";
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
            if (application?.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 403;

                return "Unauthorized";
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
              set.status = 403;
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
              set.status = 403;
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
      .post(
        "/gca-patch-documents",
        async ({ body, set, userId }) => {
          try {
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }
            if (account.role !== "GCA") {
              set.status = 403;
              return "You are not a GCA";
            }

            //TODO: WIP finish after sync with Simon
            // updateDocumentKeysSets(userId, body.documents);

            if (!document) {
              set.status = 404;
              return "Document not found";
            }
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
            documents: t.Array(
              t.Object({
                documentId: t.String(),
                keysSets: t.Array(
                  t.Object({
                    publicKey: t.String(),
                    encryptedMasterKey: t.String(),
                  })
                ),
              })
            ),
          }),
          detail: {
            summary: "Create or Update an Application",
            description: `Create an Application`,
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
