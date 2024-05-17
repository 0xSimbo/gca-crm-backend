import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";
import { updateRole } from "../../db/mutations/accounts/updateRole";

import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { Wallet } from "ethers";
import {
  MinerPoolAndGCA__factory,
  addresses,
} from "@glowlabs-org/guarded-launch-ethers-sdk";
import { createGca } from "../../db/mutations/gcas/createGca";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findAllGcas } from "../../db/queries/gcas/findAllGcas";

export const CreateGCAQueryBody = t.Object({
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
});

export const gcasRouter = new Elysia({ prefix: "/gcas" })
  .get(
    "/all",
    async ({ set }) => {
      try {
        const gcas = await findAllGcas();
        return gcas;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[gcasRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      detail: {
        summary: "Get All GCAs",
        description: `Get all GCAs and return an array of GCA objects. If no GCAs are found, it will return an empty array`,
        tags: [TAG.GCAS],
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
        "/byId",
        async ({ query, set, userId }) => {
          if (!query.id) throw new Error("ID is required");
          const account = await findFirstAccountById(userId);
          if (!account) {
            set.status = 404;
            return "Account not found";
          }
          if (account.role !== "GCA") {
            set.status = 401;
            return "You are not a GCA";
          }
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
        async ({ body, userId, set }) => {
          try {
            const wallet = userId;
            const account = await findFirstAccountById(wallet);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.gca) {
              set.status = 409;
              return "GCA already exists";
            }

            if (account.user) {
              set.status = 409;
              return "this account is already a user";
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
              set.status = 401;
              return "This wallet is not a GCA";
            }

            await updateRole(wallet, "GCA");
            await createGca({
              id: wallet,
              createdAt: new Date(),
              ...body,
            });
          } catch (e) {
            if (e instanceof Error) {
              return e.message;
            }
            console.log("[accountsRouter] create-gca", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: CreateGCAQueryBody,
          detail: {
            summary: "Create GCA Account",
            description: `Create a GCA account. If the account already exists, it will throw an error.`,
            tags: [TAG.GCAS],
          },
        }
      )
  );
