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
import { createInstaller } from "../../db/mutations/installers/createInstaller";
import { findFirstUserByEmail } from "../../db/queries/users/findFirstUserByEmail";

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
  phone: t.Nullable(
    t.String({
      example: "123-456-7890",
    })
  ),
});

export const usersRouter = new Elysia({ prefix: "/users" })
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
              set.status = 404;
              return "Account not found";
            }

            if (account.user) {
              set.status = 409;
              return "User already exists";
            }

            if (account.gca) {
              set.status = 409;
              return "this account is already a gca";
            }

            // check if email already exists
            const emailExists = await findFirstUserByEmail(body.email);
            if (emailExists) {
              set.status = 409;
              return "Email already exists";
            }

            await updateRole(wallet, "USER");
            let installerId;

            if (body.isInstaller) {
              if (!body.phone) {
                set.status = 400;
                return "Phone number is required for installer";
              }
              if (!body.companyName) {
                set.status = 400;
                return "Company Name is required for installer";
              }
              installerId = await createInstaller({
                id: wallet,
                email: body.email,
                companyName: body.companyName,
                phone: body.phone,
                name: `${body.firstName} ${body.lastName}`,
              });
            }

            await createUser({
              id: wallet,
              ...body,
              createdAt: new Date(),
              installerId: installerId || null,
            });
          } catch (e) {
            console.log("[UsersRouter] create-user", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
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
      .get(
        "/byId",
        async ({ query, set, userId }) => {
          if (!query.id) throw new Error("ID is required");
          if (userId !== query.id) {
            const account = await findFirstAccountById(userId);
            if (
              !account ||
              (account.role !== "ADMIN" && account.role !== "GCA")
            ) {
              set.status = 403;
              ("Unauthorized");
            }
          }
          try {
            const user = await findFirstUserById(query.id);
            if (!user) {
              set.status = 404;
              ("user not found");
            }

            return user;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
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
  );
