import { Elysia, t } from "elysia";
import { TAG } from "../../constants";

import { bearer as bearerplugin } from "@elysiajs/bearer";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllRewardSplitsByApplicationId } from "../../db/queries/rewardSplits/findAllRewardSplitsByApplicationId";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";
import { createSplits } from "../../db/mutations/reward-splits/createSplits";
import { updateApplicationStatus } from "../../db/mutations/applications/updateApplicationStatus";
import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { findFirstFarmById } from "../../db/queries/farms/findFirstFarmByShortId";
import { findAllDevicesByFarmId } from "../../db/queries/devices/findAllDevicesByFarmId";
import { getPubkeysAndShortIds } from "./get-pubkeys-and-short-ids";
import { db } from "../../db/db";
import { inArray } from "drizzle-orm";
import { Devices } from "../../db/schema";

export const devicesRouter = new Elysia({ prefix: "/devices" })
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
                set.status = 403;
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
              set.status = 403;
              return "Unauthorized";
            }

            const pubKeysAndShortIds = await getPubkeysAndShortIds(
              body.gcaServerurl
            );

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
