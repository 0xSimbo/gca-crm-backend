import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { FindFirstUserById } from "../../db/queries/users/findFirstUserById";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";

import { siweParams, siweParamsExample } from "../../handlers/siweHandler";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { generateSaltFromAddress } from "../../utils/encryption/generateSaltFromAddress";
import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { FindFirstById } from "../../db/queries/accounts/findFirstById";
import { createUser } from "../../db/mutations/users/createUser";

export const CreateUserQueryBody = t.Object({
  fields: t.Object({
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
  }),
  recoverAddressParams: t.Object(siweParams),
});

export const usersRouter = new Elysia({ prefix: "/users" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const user = await FindFirstUserById(query.id);
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
  .post(
    "/create-user",
    async ({ body, set }) => {
      try {
        const wallet = body.recoverAddressParams.wallet;
        const account = await FindFirstById(wallet);
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
          ...body.fields,
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
      beforeHandle: async ({
        body: {
          recoverAddressParams: { message, signature, wallet },
        },
        set,
      }) => {
        try {
          const recoveredAddress = await recoverAddressHandler(
            message,
            signature,
            wallet
          );
          if (recoveredAddress !== wallet) {
            return (set.status = 401);
          }
        } catch (error) {
          return (set.status = 401);
        }
      },
    }
  );
