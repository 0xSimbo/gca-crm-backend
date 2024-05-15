import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
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
import { Wallet } from "ethers";
import {
  MinerPoolAndGCA__factory,
  addresses,
} from "@glowlabs-org/guarded-launch-ethers-sdk";
import { createGca } from "../../db/mutations/gcas/createGca";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";

export const CreateGCAQueryBody = t.Object({
  fields: t.Object({
    publicEncryptionKey: t.String({
      example: publicEncryptionKeyExample,
    }),
    encryptedPrivateEncryptionKey: t.String({
      example: privateEncryptionKeyExample,
    }),
    serverUrls: t.Array(
      t.String({
        example: "https://api.elysia.land",
      })
    ),
    email: t.String({
      example: "JohnDoe@gmail.com",
      minLength: 2,
    }),
  }),
  recoverAddressParams: t.Object(siweParams),
});

export const gcasRouter = new Elysia({ prefix: "/gcas" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const gca = await FindFirstGcaById(query.id);
        if (!gca) {
          set.status = 404;
          throw new Error("gca not found");
        }

        return gca;
      } catch (e) {
        console.log("[gcasRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdQueryParamsSchema,
      detail: {
        summary: "Get GCA by ID",
        description: `Get GCA by ID and return the GCA object. If the GCA is not found, it will throw an error.`,
        tags: [TAG.GCAS],
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

        if (account.user) {
          throw new Error("this account is already a user");
        }

        const signer = new Wallet(process.env.PRIVATE_KEY!!);
        const minerPoolAndGCA = MinerPoolAndGCA__factory.connect(
          addresses.gcaAndMinerPoolContract,
          signer
        );
        //TODO:  remove comment when finished testing
        // const isGca = await minerPoolAndGCA["isGCA(address)"](wallet);
        const isGca = true;
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
        tags: [TAG.GCAS],
      },
    }
  );
