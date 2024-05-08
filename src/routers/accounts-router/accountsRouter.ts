import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { FindFirstById } from "../../db/queries/accounts/findFirstById";
import { createAccount } from "../../db/mutations/accounts/createAccount";
import {
  MinerPoolAndGCA__factory,
  addresses,
} from "@glowlabs-org/guarded-launch-ethers-sdk";
import { Wallet } from "ethers";
import { createFarmOwner } from "../../db/mutations/farm-owners/createFarmOwner";
import { publicEncriptionKeyExample } from "../../examples/publicEncriptionKey";
import { createGca } from "../../db/mutations/gcas/createGca";
import {
  siweHandler,
  siweParams,
  siweParamsExample,
} from "../../handlers/siweHandler";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { updateSiweNonce } from "../../db/mutations/accounts/updateSiweNonce";

export const LoginOrSignupQueryBody = t.Object(siweParams, {
  examples: [siweParamsExample],
});

export const CreateFarmOwnerQueryBody = t.Object(
  {
    fields: t.Object({
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
  },
  {
    examples: [
      {
        fields: {
          firstName: "John",
          lastName: "Doe",
          email: "JohnDoe@gmail.com",
          companyName: "Solar Energy",
          companyAddress: "123 John Doe Street",
        },
        recoverAddressParams: siweParamsExample,
      },
    ],
  }
);

// key generated with ssh-keygen -t rsa -b 4096
export const CreateGCAQueryBody = t.Object(
  {
    fields: t.Object({
      publicEncriptionKey: t.String({
        example: publicEncriptionKeyExample,
        minLength: 716,
        maxLength: 716,
      }),
      serverUrls: t.Array(
        t.String({
          example: "https://api.elysia.land",
        })
      ),
    }),
    recoverAddressParams: t.Object(siweParams),
  },
  {
    examples: [
      {
        fields: {
          publicEncriptionKey: publicEncriptionKeyExample,
          serverUrls: ["https://api.elysia.land"],
        },
        recoverAddressParams: siweParamsExample,
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
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const account = await FindFirstById(query.id);
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
      query: GetAccountByIdQueryParamSchema,
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
        let account = await FindFirstById(body.wallet);

        if (!account) {
          await createAccount(body.wallet, "UNKNOWN", body.nonce);
          account = await FindFirstById(body.wallet);
        } else {
          await updateSiweNonce(body.wallet, body.nonce);
        }
        //refetch with updates
        account = await FindFirstById(body.wallet);
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
  )
  .post(
    "/create-farm-owner",
    async ({ body, set }) => {
      try {
        const wallet = body.recoverAddressParams.wallet;
        const account = await FindFirstById(wallet);
        if (!account) {
          throw new Error("Account not found");
        }

        if (account.farmOwner) {
          throw new Error("Farm Owner already exists");
        }
        await updateRole(wallet, "FARM_OWNER");
        await createFarmOwner({
          id: wallet,
          ...body.fields,
          createdAt: new Date(),
        });
      } catch (e) {
        console.log("[accountsRouter] create-farm-owner", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: CreateFarmOwnerQueryBody,
      detail: {
        summary: "Create Farm Owner Account",
        description: `Create a Farm Owner account. If the account already exists, it will throw an error.`,
        tags: [TAG.ACCOUNTS],
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
  )
  .post(
    "/create-gca",
    async ({ body }) => {
      try {
        const wallet = body.recoverAddressParams.wallet;
        const account = await FindFirstById(wallet);
        if (!account) {
          throw new Error("Account not found");
        }

        if (account.gca) {
          throw new Error("GCA already exists");
        }

        const signer = new Wallet(process.env.PRIVATE_KEY!!);
        const minerPoolAndGCA = MinerPoolAndGCA__factory.connect(
          addresses.gcaAndMinerPoolContract,
          signer
        );
        const isGca = await minerPoolAndGCA["isGCA(address)"](wallet);
        if (!isGca) {
          throw new Error("This wallet is not a GCA");
        }

        await updateRole(wallet, "GCA");
        await createGca({
          id: wallet,
          createdAt: new Date(),
          ...body.fields,
        });
      } catch (e) {
        console.log("[accountsRouter] create-gca", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: CreateGCAQueryBody,
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
      detail: {
        summary: "Create GCA Account",
        description: `Create a GCA account. If the account already exists, it will throw an error.`,
        tags: [TAG.ACCOUNTS],
      },
    }
  );
