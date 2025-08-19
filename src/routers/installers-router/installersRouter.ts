import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { jwtHandler } from "../../handlers/jwtHandler";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { createInstaller } from "../../db/mutations/installers/createInstaller";
import { updateUser } from "../../db/mutations/users/updateUser";
import { findFirstInstallerById } from "../../db/queries/installers/findFirstInstallerById";
import { updateInstaller } from "../../db/mutations/installers/updateInstaller";
import { findAllCertifiedInstallers } from "../../db/queries/installers/findAllCertifiedInstallers";
import { findAllInstallers } from "../../db/queries/installers/findAllInstallers";

export const CreateInstallerQueryBody = t.Object({
  name: t.String({
    example: "John",
    minLength: 2,
  }),
  email: t.String({
    example: "JohnDoe@gmail.com",
    minLength: 2,
  }),
  companyName: t.String({
    example: "John Doe Farms",
  }),
  phone: t.String({
    example: "123-456-7890",
  }),
});

export const installersRouter = new Elysia({ prefix: "/installers" })
  // Public routes
  .get(
    "/certified",
    async ({ set }) => {
      try {
        const installers = await findAllCertifiedInstallers();
        return installers;
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
      detail: {
        summary: "Get all certified installers",
        description: `Returns all installers with isCertified=true. Includes id, name, email, companyName, phone, isCertified and zoneIds`,
        tags: [TAG.INSTALLERS],
      },
    }
  )
  .get(
    "/all",
    async ({ headers, set }) => {
      try {
        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          set.status = 400;
          return "API Key is required";
        }
        if (apiKey !== process.env.GUARDED_API_KEY) {
          set.status = 401;
          return "Unauthorized";
        }
        const installers = await findAllInstallers();
        return installers;
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
      detail: {
        summary: "Get all installers",
        description: `Returns all installers. Accessible only with a valid x-api-key.`,
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
      .post(
        "/create",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            if (user.isInstaller && user.installer) {
              set.status = 400;
              return "Installer already linked to your account";
            }

            let installerId;

            installerId = await createInstaller({
              email: body.email,
              companyName: body.companyName,
              phone: body.phone,
              name: body.name,
            });

            await updateUser({ installerId }, userId);
            return { installerId };
          } catch (e) {
            console.log("[installersRouter] create", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            throw new Error("Error Occured");
          }
        },
        {
          body: CreateInstallerQueryBody,
          detail: {
            summary: "Create an Installer and link to User",
            description: `Create an Installer and link to User. If the user is already linked to an installer, it will throw an error.`,
            tags: [TAG.INSTALLERS],
          },
        }
      )
      .post(
        "/update",
        async ({ query, body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            const installerId = query.installerId;
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            if (!installerId) {
              set.status = 400;
              return "Installer ID is required";
            }

            console.log({ installerId });

            await updateInstaller(
              {
                email: body.email,
                companyName: body.companyName,
                phone: body.phone,
                name: body.name,
              },
              installerId
            );
            return { installerId };
          } catch (e) {
            console.log("[installersRouter] create", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            throw new Error("Error Occured");
          }
        },
        {
          body: CreateInstallerQueryBody,
          query: t.Object({
            installerId: t.String(),
          }),
          detail: {
            summary: "Create an Installer and link to User",
            description: `Create an Installer and link to User. If the user is already linked to an installer, it will throw an error.`,
            tags: [TAG.INSTALLERS],
          },
        }
      )
  )
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");

      try {
        const installer = await findFirstInstallerById(query.id);
        if (!installer) {
          set.status = 404;
          return "installer not found";
        }

        return installer;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[installersRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get Installer by ID",
        description: `Get a Installer by ID. If the installer does not exist, it will throw an error.`,
        tags: [TAG.INSTALLERS],
      },
    }
  );
