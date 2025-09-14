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
  findActiveFractionByApplicationId,
} from "../../db/queries/fractions/findFractionsByApplicationId";
import { findFractionSplits } from "../../db/queries/fractions/findFractionSplits";
import { findActiveDefaultMaxSplits } from "../../db/queries/defaultMaxSplits/findActiveDefaultMaxSplits";

export const fractionsRouter = new Elysia({ prefix: "/fractions" })
  .get(
    "/default-max-splits",
    async ({ query: { applicationId }, set }) => {
      if (!applicationId) {
        set.status = 400;
        return "applicationId is required";
      }

      try {
        // Get the application to check if it has a custom maxSplits value
        const application = await FindFirstApplicationById(applicationId);
        if (!application) {
          set.status = 404;
          return "Application not found";
        }

        // If application has a custom maxSplits value (not 0), return it
        if (application.maxSplits && application.maxSplits !== "0") {
          return {
            maxSplits: application.maxSplits.toString(),
            isDefault: false,
            source: "application_override",
          };
        }

        // Otherwise, get the default maxSplits
        const defaultMaxSplitsResult = await findActiveDefaultMaxSplits();
        if (defaultMaxSplitsResult.length === 0) {
          set.status = 404;
          return "No default maxSplits configuration found";
        }

        return {
          maxSplits: defaultMaxSplitsResult[0].maxSplits.toString(),
          isDefault: true,
          source: "default_configuration",
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /default-max-splits", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        applicationId: t.String(),
      }),
      detail: {
        summary: "Get default or application-specific maxSplits value",
        description:
          "Returns the maxSplits value for an application - either the application-specific override or the default configuration. This determines the maximum number of fraction splits that can be sold for the application.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
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
      .get(
        "/active-by-application-id",
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

            const activeFraction = await findActiveFractionByApplicationId(
              applicationId
            );

            if (!activeFraction) {
              set.status = 404;
              return "No active fraction found for this application";
            }

            return activeFraction;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /active-by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Get active fraction by application ID",
            description:
              "Returns the active fraction for an application (not expired and not committed on-chain)",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/splits",
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

            const splits = await findFractionSplits(fractionId);
            return {
              fractionId,
              totalSplits: splits.length,
              splits,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /splits", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            fractionId: t.String(),
          }),
          detail: {
            summary: "Get fraction splits by fraction ID",
            description: "Returns all splits (sales) for a specific fraction",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
