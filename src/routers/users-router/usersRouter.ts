import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { createUser } from "../../db/mutations/users/createUser";
import { jwtHandler } from "../../handlers/jwtHandler";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";

export const CreateUserQueryBody = t.Object({
  encryptedPrivateEncryptionKey: t.String({
    example: privateEncryptionKeyExample,
  }),
  isInstaller: t.Boolean({
    example: false,
  }),
  publicEncryptionKey: t.String({
    example: publicEncryptionKeyExample,
  }),
  firstName: t.String({
    example: "John",
    minLength: 2,
  }),
  lastName: t.String({
    example: "Doe",
    minLength: 2,
  }),
  email: t.String({
    example: "JohnDoe@gmail.com",
    minLength: 2,
  }),
  companyName: t.Nullable(
    t.String({
      example: "John Doe Farms",
    })
  ),
  companyAddress: t.Nullable(
    t.String({
      example: "123 John Doe Street",
    })
  ),
});

export const usersRouter = new Elysia({ prefix: "/users" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const user = await findFirstUserById(query.id);
        if (!user) {
          set.status = 404;
          throw new Error("user not found");
        }

        return user;
      } catch (e) {
        console.log("[UsersRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdQueryParamsSchema,
      detail: {
        summary: "Get User by ID",
        description: `Get a User by ID. If the user does not exist, it will throw an error.`,
        tags: [TAG.USERS],
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
        "/create-user",
        async ({ body, set, userId }) => {
          try {
            console.log("create", userId);
            const wallet = userId;
            const account = await findFirstAccountById(userId);
            if (!account) {
              throw new Error("Account not found");
            }

            if (account.user) {
              throw new Error("User already exists");
            }

            if (account.gca) {
              throw new Error("this account is already a gca");
            }

            await updateRole(wallet, "USER");

            await createUser({
              id: wallet,
              ...body,
              createdAt: new Date(),
            });
          } catch (e) {
            console.log("[UsersRouter] create-user", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: CreateUserQueryBody,
          detail: {
            summary: "Create User Account",
            description: `Create a User account. If the account already exists, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
  );
