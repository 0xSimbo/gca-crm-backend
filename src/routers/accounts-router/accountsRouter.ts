import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { createAccount } from "../../db/mutations/accounts/createAccount";
import {
  siweHandler,
  siweParams,
  siweParamsExample,
} from "../../handlers/siweHandler";
import { updateSiweNonce } from "../../db/mutations/accounts/updateSiweNonce";

import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { generateSaltFromAddress } from "../../utils/encryption/generateSaltFromAddress";

export const LoginOrSignupQueryBody = t.Object(siweParams);

export const accountsRouter = new Elysia({ prefix: "/accounts" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const account = await findFirstAccountById(query.id);
        if (!account) {
          set.status = 404;
          throw new Error("Account not found");
        }
        // remove nonce from response
        return { ...account, siweNonce: undefined };
      } catch (e) {
        console.log("[accountsRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdQueryParamsSchema,
      detail: {
        summary: "Get Account by ID",
        description: `Get account by ID`,
        tags: [TAG.ACCOUNTS],
      },
    }
  )
  .post(
    "/loginOrSignup",
    async ({ body }) => {
      try {
        let account = await findFirstAccountById(body.wallet);

        if (!account) {
          const salt = generateSaltFromAddress(body.wallet);

          await createAccount({
            id: body.wallet,
            siweNonce: body.nonce,
            salt,
            createdAt: new Date(),
            role: "UNKNOWN",
          });
          account = await findFirstAccountById(body.wallet);
        } else {
          await updateSiweNonce(body.wallet, body.nonce);
        }
        //refetch with updates
        account = await findFirstAccountById(body.wallet);
        return account;
      } catch (e) {
        console.log("[accountsRouter] loginOrSignup", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: LoginOrSignupQueryBody,
      detail: {
        summary: "Login or Signup",
        description: `Login or Signup with wallet address. If the account does not exist, it will create a new account with the wallet address.`,
        tags: [TAG.ACCOUNTS],
      },
      beforeHandle: async ({ body: { wallet, message, signature }, set }) => {
        try {
          const recoveredAddress = await siweHandler(message, signature);
          if (recoveredAddress !== wallet) {
            return (set.status = 401);
          }
        } catch (error) {
          return (set.status = 401);
        }
      },
    }
  );
