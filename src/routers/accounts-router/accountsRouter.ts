import { Elysia, t } from "elysia";
import { accountRoleEnum, accountRoles } from "../../db/schema";
import { TAG } from "../../constants";
import { FindFirstById } from "../../db/queries/accounts/findFirstById";
import { createAccount } from "../../db/mutations/accounts/createAccount";
import { SiweMessage } from "siwe";
import {
  MinerPoolAndGCA__factory,
  addresses,
} from "@glowlabs-org/guarded-launch-ethers-sdk";
import { Wallet } from "ethers";

export const LoginOrSignupQueryBody = t.Object(
  {
    wallet: t.String({
      minLength: 42,
      maxLength: 42,
    }),
    message: t.String({
      minLength: 1,
    }),
    signature: t.String({
      minLength: 132,
      maxLength: 132,
    }),
    role: t.String({
      enum: accountRoles,
    }),
  },
  {
    examples: [
      {
        wallet: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
        message: "Sign this message to verify your wallet",
        signature: "0x" + "a".repeat(130) + "1b", // 132 characters
        role: "FARM_OWNER",
      },
    ],
  }
);

export const GetAccountByIdQueryParamSchema = t.Object(
  {
    id: t.String({
      minLength: 42,
      maxLength: 42,
    }),
  },
  {
    examples: [
      {
        id: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
      },
    ],
  }
);

export const accountsRouter = new Elysia({ prefix: "/accounts" })
  .post(
    "/loginOrSignup",
    async ({ body }) => {
      try {
        const account = await FindFirstById(body.wallet);

        if (!account) {
          if (body.role === "ADMIN") {
            throw new Error("Admin account not found");
          }
          if (body.role === "GCA") {
            const signer = new Wallet(process.env.PRIVATE_KEY!!);
            const minerPoolAndGCA = MinerPoolAndGCA__factory.connect(
              addresses.gcaAndMinerPoolContract,
              signer
            );
            const isGca = await minerPoolAndGCA["isGCA(address)"](body.wallet);
            if (!isGca) {
              throw new Error("This wallet is not a GCA");
            }
          }

          await createAccount(
            body.wallet,
            body.role as (typeof accountRoleEnum.enumValues)[number]
          );
          return await FindFirstById(body.wallet);
        }
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
        description: `Login or Signup with your wallet address. If the account does not exist, it will be created.`,
        tags: [TAG.ACCOUNTS],
      },
      beforeHandle: async ({ body, set }) => {
        // verify signature before handling the request
        const siwe = new SiweMessage(JSON.parse(body.message || "{}"));
        await siwe.verify({ signature: body.signature || "" });
        if (siwe.address !== body.wallet) {
          // return custom error code
          set.status = 401;
          throw new Error("Invalid Signature for wallet " + body.wallet);
        }
      },
    }
  )
  .get(
    "/byId",
    async ({ body, set }) => {
      try {
        const account = await FindFirstById(body.id);
        if (!account) {
          set.status = 404;
          throw new Error("Account not found");
        }
        return account;
      } catch (e) {
        console.log("[accountsRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: GetAccountByIdQueryParamSchema,
      detail: {
        summary: "Get Account by ID",
        description: `Get account by ID`,
        tags: [TAG.ACCOUNTS],
      },
    }
  );