import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";
import { updateRole } from "../../db/mutations/accounts/updateRole";

import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { Wallet, ethers } from "ethers";
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
import { updateServers } from "../../db/mutations/gcas/updateServers";
import { db } from "../../db/db";

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
        set.status = 400;
        if (e instanceof Error) {
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
        "/public-encryption-keys",
        async ({ set, userId }) => {
          try {
            console.log("userId", userId);
            const account = await findFirstAccountById(userId);

            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            const gcaPubKeys = db.query.Gcas.findMany({
              columns: {
                publicEncryptionKey: true,
              },
            });
            return gcaPubKeys;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[documentsRouter] /all-by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get All Public Encryption Keys",
            description: `Get all public encryption keys of GCAs and return an array of public encryption keys. If no GCAs are found, it will return an empty array`,
            tags: [TAG.GCAS],
          },
        }
      )
      .get(
        "/currrent",
        async ({ set, userId }) => {
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
            const gca = await FindFirstGcaById(userId);
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

            const provider = new ethers.providers.StaticJsonRpcProvider({
              url: process.env.MAINNET_RPC_URL!!,
              skipFetchSetup: true,
            });
            const minerPoolAndGCA = MinerPoolAndGCA__factory.connect(
              addresses.gcaAndMinerPoolContract,
              provider
            );

            if (process.env.NODE_ENV === "production") {
              const allGcas = await minerPoolAndGCA.allGcas();
              const isGca = allGcas
                .map((c) => c.toLowerCase())
                .includes(wallet.toLowerCase());
              if (!isGca) {
                set.status = 401;
                return "This wallet is not a GCA";
              }
            }

            await createGca({
              id: wallet,
              createdAt: new Date(),
              ...body,
            });
            await updateRole(wallet, "GCA");
          } catch (e) {
            set.status = 400;
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
      .post(
        "/update-servers",
        async ({ body, userId, set }) => {
          try {
            const wallet = userId;
            const account = await findFirstAccountById(wallet);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            // TODO: ping server to check if it is valid @0xSimbo

            if (account.role !== "GCA") {
              set.status = 401;
              return "You are not a GCA";
            }
            await updateServers(wallet, body.serverUrls);
          } catch (e) {
            set.status = 400;
            if (e instanceof Error) {
              return e.message;
            }
            console.log("[accountsRouter] update-servers-url", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({ serverUrls: t.Array(t.String()) }),
          detail: {
            summary: "Create ",
            description: `Create `,
            tags: [TAG.GCAS],
          },
        }
      )
  );
