import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import {
  findFractionsByApplicationId,
  findFractionById,
} from "../../db/queries/fractions/findFractionsByApplicationId";
import { markFractionAsCommitted } from "../../db/mutations/fractions/createFraction";

export const fractionsRouter = new Elysia({ prefix: "/fractions" })
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
        "/by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) {
            set.status = 400;
            return "applicationId is required";
          }

          try {
            const application = await FindFirstApplicationById(applicationId);
            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            // Check if user has access to this application
            if (application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            const fractions = await findFractionsByApplicationId(applicationId);
            return fractions;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Get fractions by application ID",
            description:
              "Returns all fractions created for a specific application",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/by-id",
        async ({ query: { fractionId }, set, userId }) => {
          if (!fractionId) {
            set.status = 400;
            return "fractionId is required";
          }

          try {
            const fraction = await findFractionById(fractionId);
            if (!fraction) {
              set.status = 404;
              return "Fraction not found";
            }

            const application = await FindFirstApplicationById(
              fraction.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Associated application not found";
            }

            // Check if user has access to this fraction
            if (
              application.userId !== userId &&
              fraction.createdBy !== userId
            ) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            return fraction;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /by-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            fractionId: t.String(),
          }),
          detail: {
            summary: "Get fraction by ID",
            description: "Returns a specific fraction by its ID",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/mark-as-committed",
        async ({ body, set, userId }) => {
          try {
            const fraction = await findFractionById(body.fractionId);
            if (!fraction) {
              set.status = 404;
              return "Fraction not found";
            }

            // Check if user is the creator of this fraction
            if (fraction.createdBy !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            if (fraction.isCommittedOnChain) {
              set.status = 400;
              return "Fraction is already committed on-chain";
            }

            const updatedFraction = await markFractionAsCommitted(
              body.fractionId,
              body.txHash
            );

            return updatedFraction[0];
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /mark-as-committed", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            fractionId: t.String({
              description: "The fraction ID (bytes32 hex string)",
            }),
            txHash: t.String({
              description: "The transaction hash of the on-chain commitment",
              minLength: 66,
              maxLength: 66,
            }),
          }),
          detail: {
            summary: "Mark fraction as committed on-chain",
            description:
              "Updates a fraction to mark it as committed on-chain with the transaction hash",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
