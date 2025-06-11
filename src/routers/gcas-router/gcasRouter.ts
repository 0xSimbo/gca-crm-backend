import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { ethers } from "ethers";
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
import { deleteGcaDelegatedUserById } from "../../db/mutations/gcaDelegatedUsers/deleteGcaDelegatedUserById";
import { createGcaDelegatedUser } from "../../db/mutations/gcaDelegatedUsers/createGcaDelegatedUser";
import { findFirstDelegatedUserByUserId } from "../../db/queries/gcaDelegatedUsers/findFirstDelegatedUserByUserId";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { findAllGcaDelegatedUsers } from "../../db/queries/gcaDelegatedUsers/findAllGcaDelegatedUsers";
import { createApplicationEncryptedMasterKeysForUsers } from "../../db/mutations/applications/createApplicationEncryptedMasterKeysForUsers";
import { createWeeklyReport } from "@glowlabs-org/utils";
import { getProtocolWeek } from "../../utils/getProtocolWeek";

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
  .get(
    "/weekly-reports",
    async ({ set }) => {
      try {
        const currrentWeek = getProtocolWeek() - 1;
        const { headlineStats } = await createWeeklyReport({
          apiUrl: `https://fun-rust-production.up.railway.app/headline_farm_stats`,
          gcaUrls: ["http://95.217.194.59:35015"],
          week: currrentWeek,
        });
        return headlineStats;
      } catch (e) {
        set.status = 400;
        if (e instanceof Error) {
          return e.message;
        }
        console.log("[gcasRouter] weekly-reports", e);
        throw new Error("Error Occured");
      }
    },
    {
      detail: {
        summary: "Get Weekly Reports",
        description: `Get weekly reports Json data`,
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
            console.log("[gcasRouter] /all-by-application-id", e);
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
      .get(
        "/delegated-users",
        async ({ set, userId }) => {
          try {
            console.log("userId", userId);
            const gca = await FindFirstGcaById(userId);

            if (!gca) {
              set.status = 404;
              return "GCA not found";
            }

            const delegatedUsers = await findAllGcaDelegatedUsers(userId);
            return delegatedUsers;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[gcasRouter] /delegated-users", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get All Delegated Users",
            description: `Get all delegated users of a GCA and return an array of delegated user objects. If no delegated users are found, it will return an empty array`,
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

            // if (process.env.NODE_ENV === "production") {
            const allGcas = await minerPoolAndGCA.allGcas();
            const isGca = allGcas
              .map((c) => c.toLowerCase())
              .includes(wallet.toLowerCase());
            if (!isGca) {
              set.status = 401;
              return "This wallet is not a GCA";
            }
            // }

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
      .post(
        "/delegate-user",
        async ({ body, set, userId: gcaId }) => {
          try {
            const gca = await FindFirstGcaById(gcaId);

            if (!gca) {
              set.status = 404;
              return "GCA not found";
            }

            const user = await findFirstUserById(body.userId);

            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const delegatedUser = await findFirstDelegatedUserByUserId(
              body.userId
            );
            if (delegatedUser) {
              set.status = 409;
              return "User already delegated";
            }

            const gcaDelegatedUserId = await createGcaDelegatedUser({
              gcaId,
              userId: body.userId,
              createdAt: new Date(),
            });

            if (body.delegatedApplicationsEncryptedMasterKeysByGca.length > 0) {
              await createApplicationEncryptedMasterKeysForUsers(
                body.delegatedApplicationsEncryptedMasterKeysByGca.map((u) => ({
                  ...u,
                  gcaDelegatedUserId,
                }))
              );
            }
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[gcasRouter] delegate-user", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            userId: t.String(),
            delegatedApplicationsEncryptedMasterKeysByGca: t.Array(
              t.Object({
                encryptedMasterKey: t.String(),
                applicationId: t.String(),
                userId: t.String(),
              })
            ),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.GCAS],
          },
        }
      )
      .post(
        "/delete-delegated-user",
        async ({ body, set, userId: gcaId }) => {
          try {
            const gca = await FindFirstGcaById(gcaId);

            if (!gca) {
              set.status = 404;
              return "GCA not found";
            }

            const gcaDelegatedUser = await findFirstDelegatedUserByUserId(
              body.userId
            );
            if (!gcaDelegatedUser) {
              set.status = 404;
              return "Delegated user not found";
            }

            await deleteGcaDelegatedUserById(gcaDelegatedUser.id);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[gcasRouter] delete-delegated-user", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            userId: t.String(),
          }),
          detail: {
            summary: "Delete Delegated User",
            description: `Delete Delegated User and all associated delegated Encrypted Documents Master Keys`,
            tags: [TAG.GCAS],
          },
        }
      )
  );
