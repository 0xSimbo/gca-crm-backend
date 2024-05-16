import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { jwtHandler } from "../../handlers/jwtHandler";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { createInstaller } from "../../db/mutations/installers/createInstaller";
import { updateUser } from "../../db/mutations/users/updateUser";
import { findFirstInstallerById } from "../../db/queries/installers/findFirstInstallerById";
import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";

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
            tags: [TAG.USERS],
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
      query: GetEntityByIdQueryParamsSchema,
      detail: {
        summary: "Get Installer by ID",
        description: `Get a Installer by ID. If the installer does not exist, it will throw an error.`,
        tags: [TAG.USERS],
      },
    }
  );
