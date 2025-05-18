import { Elysia, t } from "elysia";
import { TAG } from "../../constants";

import { bearer as bearerplugin } from "@elysiajs/bearer";

import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findFirstFarmIdByShortId } from "../../db/queries/farms/findFirstFarmIdByShortId";
import { db } from "../../db/db";

export const farmsRouter = new Elysia({ prefix: "/farms" })
  .use(bearerplugin())
  .get(
    "/regions",
    async ({ set }) => {
      try {
        const farms = await db.query.farms.findMany({
          columns: {
            id: true,
            region: true,
            regionFullName: true,
            signalType: true,
          },
          with: {
            devices: {
              columns: {
                id: true,
                shortId: true,
                publicKey: true,
                isEnabled: true,
                enabledAt: true,
                disabledAt: true,
              },
            },
          },
        });
        return farms.map((farm) => ({
          farmId: farm.id,
          region: farm.region,
          regionFullName: farm.regionFullName,
          signalType: farm.signalType,
          devices: farm.devices,
        }));
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      detail: {
        summary: "Get all farms with region info and devices",
        description: `Returns all farms with their farmId, region, regionFullName, signalType, and devices`,
        tags: [TAG.FARMS],
      },
    }
  )
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .get(
        "/by-short-id", // Get Farm id by Short ID also known as device short ID
        async ({ query: { shortId }, set, userId }) => {
          if (!shortId) throw new Error("shortId is required");
          try {
            const account = await findFirstAccountById(userId);

            if (
              !account ||
              (account.role !== "ADMIN" && account.role !== "GCA")
            ) {
              set.status = 401;
              return "Unauthorized";
            }

            const farmId = await findFirstFarmIdByShortId(shortId);
            if (!farmId) {
              set.status = 404;
              return "Farm not found";
            }
            return farmId;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[devicesRouter] /by-short-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            shortId: t.String(),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.FARMS],
          },
        }
      )
  );
