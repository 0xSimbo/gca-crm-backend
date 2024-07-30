import { Elysia, t } from "elysia";
import { TAG } from "../../constants";

import { bearer as bearerplugin } from "@elysiajs/bearer";

import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";

import { findAllDevicesByFarmId } from "../../db/queries/devices/findAllDevicesByFarmId";
import { getPubkeysAndShortIds } from "./get-pubkeys-and-short-ids";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import { DeviceInsertType, Devices } from "../../db/schema";
import { findFirstFarmById } from "../../db/queries/farms/findFirstFarmById";
import { findFirstFarmIdByShortId } from "../../db/queries/farms/findFirstFarmIdByShortId";
import { FindFirstGcaById } from "../../db/queries/gcas/findFirsGcaById";
import { findFirstDeviceByPublicKey } from "../../db/queries/devices/findFirstDeviceByPublicKey";

export const devicesRouter = new Elysia({ prefix: "/devices" })
  .post(
    "/create",
    async ({ body, set, headers }) => {
      const apiKey = headers["x-api-key"];
      if (!apiKey) {
        set.status = 401;
        return "API Key is required";
      }
      if (apiKey !== process.env.API_KEY) {
        set.status = 401;
        return "API Key is invalid";
      }
      try {
        const device: DeviceInsertType = {
          publicKey: body.publicKey,
          shortId: body.shortId,
          farmId: body.farmId,
        };

        const insertRes = await db.insert(Devices).values(device).returning({
          id: Devices.id,
        });
        return insertRes[0].id;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[devicesRouter] /create", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        publicKey: t.String(),
        shortId: t.String(),
        farmId: t.String(),
        isEnabled: t.Boolean(),
        enabledAt: t.String(),
        disabled_at: t.String(),
      }),
      detail: {
        summary: "Create a device",
        description: `Create a device with the given name, public key, short id and farm id`,
        tags: [TAG.DEVICES],
      },
    }
  )
  .post(
    "/toggle-device",
    async ({ body, set, headers }) => {
      const apiKey = headers["x-api-key"];
      if (!apiKey) {
        set.status = 401;
        return "API Key is required";
      }
      if (apiKey !== process.env.API_KEY) {
        set.status = 401;
        return "API Key is invalid";
      }
      try {
        await db
          .update(Devices)
          .set({
            isEnabled: body.isEnabled,
            enabledAt: body.enabledAt ? new Date(body.enabledAt) : null,
            disabledAt: body.disabledAt ? new Date(body.disabledAt) : null,
          })
          .where(eq(Devices.publicKey, body.publicKey));

        return { success: true };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[devicesRouter] /toggle-device", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        publicKey: t.String(),
        isEnabled: t.Boolean(),
        enabledAt: t.Nullable(t.String()),
        disabledAt: t.Nullable(t.String()),
      }),
      detail: {
        summary: "Toggle Device status by public key",
        description: `Toggle Device status by public key, update isEnabled, enabledAt and disabledAt`,
        tags: [TAG.DEVICES],
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
        "/replace-device",
        async ({ body, set, userId }) => {
          const gca = await FindFirstGcaById(userId);
          if (!gca) {
            set.status = 401;
            return "Unauthorized";
          }
          const serverUrl = gca.serverUrls[0];
          try {
            const farmId = await findFirstFarmIdByShortId(body.previousShortId);
            if (!farmId) {
              set.status = 404;
              return "Farm not found";
            }

            const pubKeysAndShortIds = await getPubkeysAndShortIds(serverUrl);

            const newDevicePubKey = pubKeysAndShortIds.find(
              (c) => c.shortId === Number(body.newShortId)
            )?.pubkey;

            if (!newDevicePubKey) {
              set.status = 404;
              return "New device not found";
            }

            const newDeviceAlreadyExist = await findFirstDeviceByPublicKey(
              newDevicePubKey
            );

            if (newDeviceAlreadyExist) {
              set.status = 400;
              return "New device already exist";
            }

            const previousDevicePubKey = pubKeysAndShortIds.find(
              (c) => c.shortId === Number(body.previousShortId)
            )?.pubkey;

            if (!previousDevicePubKey) {
              set.status = 404;
              return "Previous device not found";
            }

            const previousDevice = await findFirstDeviceByPublicKey(
              previousDevicePubKey
            );

            if (!previousDevice) {
              set.status = 404;
              return "Previous device not found";
            }

            if (!previousDevice.isEnabled) {
              set.status = 400;
              return "Previous device is already disabled";
            }

            const device: DeviceInsertType = {
              publicKey: newDevicePubKey,
              shortId: body.newShortId,
              farmId: farmId,
              enabledAt: new Date(),
              previousPublicKey: previousDevice.publicKey,
            };

            await db.transaction(async (trx) => {
              await trx.insert(Devices).values(device).returning({
                id: Devices.id,
              });
              await trx
                .update(Devices)
                .set({
                  isEnabled: false,
                  disabledAt: new Date(),
                })
                .where(eq(Devices.id, previousDevice.id));
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[devicesRouter] /replace-device", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            previousShortId: t.String(),
            newShortId: t.String(),
          }),
          detail: {
            summary: "Replace a device",
            description: `Replace a device with the given previous short id and new short id, it will disable the previous device and create a new device with the new short id`,
            tags: [TAG.DEVICES],
          },
        }
      )
      .get(
        "/all-by-farm-id",
        async ({ query: { id }, set, userId }) => {
          if (!id) throw new Error("farmId is required");
          try {
            const farm = await findFirstFarmById(id);
            if (farm?.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }
            const devices = await findAllDevicesByFarmId(id);

            return devices;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[devicesRouter] /all-by-farm-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Get All devices by Farm ID",
            description: `Get all devices by Farm ID and check if the farm is owned by the user, if not, it will throw an error if you are not an admin or GCA`,
            tags: [TAG.DEVICES],
          },
        }
      )
      .post(
        "/get-devices-by-gca-server",
        async ({ body, set, userId }) => {
          try {
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 404;
              throw new Error("Account not found");
            }

            if (account.role !== "GCA") {
              set.status = 400;
              return "Unauthorized";
            }

            const pubKeysAndShortIds = await getPubkeysAndShortIds(
              body.gcaServerurl
            );

            if (!pubKeysAndShortIds.length) {
              return [];
            }

            const devicesAlreadyInDb = await db.query.Devices.findMany({
              where: inArray(
                Devices.publicKey,
                pubKeysAndShortIds.map((c) => c.pubkey)
              ),
            });
            return pubKeysAndShortIds.filter(
              (d) => !devicesAlreadyInDb.find((db) => db.publicKey === d.pubkey)
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[rewardSplitsRouter] get-devices-by-gca-server", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            gcaServerurl: t.String(),
          }),
          detail: {
            summary: "Get Devices by GCA Server",
            description: `Get devices by GCA server, if you are not a GCA, it will throw an error`,
            tags: [TAG.DEVICES],
          },
        }
      )
  );
