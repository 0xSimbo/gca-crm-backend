import { Elysia, t } from "elysia";
import { TAG } from "../../constants";

import { bearer as bearerplugin } from "@elysiajs/bearer";

import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findFirstFarmIdByShortId } from "../../db/queries/farms/findFirstFarmIdByShortId";
import { findFarmsByUserId } from "../../db/queries/farms/findFarmsByUserId";
import { db } from "../../db/db";
import { createHash } from "crypto"; // Node.js built-in
import { farms } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getAllUniqueNames } from "./generateNames";

/**
 * Returns a unique star name for a given applicationId, checking for collisions in the farms table.
 * Tries up to maxAttempts, using a hash of applicationId and attempt for deterministic selection.
 * Returns undefined if no unique name is found.
 */
export async function getUniqueStarNameForApplicationId(
  applicationId: string,
  maxAttempts = 10
): Promise<string | undefined> {
  const allNames = getAllUniqueNames();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hash = createHash("sha256")
      .update(applicationId + attempt)
      .digest("hex");
    const hashInt = parseInt(hash.slice(0, 12), 16);
    const index = hashInt % allNames.length;
    const name = allNames[index];
    if (!name) continue;
    const exists = await db.query.farms.findFirst({
      where: (farms, { ilike }) => ilike(farms.name, name),
      columns: { id: true },
    });
    if (!exists) return name;
  }
  return undefined;
}

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
  .get(
    "/region",
    async ({ query, set }) => {
      try {
        const { publicKey, shortId, farmId } = query;
        let farm;
        if (publicKey) {
          const device = await db.query.Devices.findFirst({
            where: (devices, { eq }) => eq(devices.publicKey, publicKey),
            with: {
              farm: {
                columns: {
                  id: true,
                  region: true,
                  regionFullName: true,
                  signalType: true,
                },
              },
            },
          });
          farm = device?.farm;
        } else if (shortId) {
          const device = await db.query.Devices.findFirst({
            where: (devices, { eq }) => eq(devices.shortId, shortId),
            with: {
              farm: {
                columns: {
                  id: true,
                  region: true,
                  regionFullName: true,
                  signalType: true,
                },
              },
            },
          });
          farm = device?.farm;
        } else if (farmId) {
          farm = await db.query.farms.findFirst({
            where: (farms, { eq }) => eq(farms.id, farmId),
            columns: {
              id: true,
              region: true,
              regionFullName: true,
              signalType: true,
            },
          });
        } else {
          set.status = 400;
          return "You must provide one of: publicKey, shortId, or farmId";
        }
        if (!farm) {
          set.status = 404;
          return "Region not found";
        }
        return {
          farmId: farm.id,
          region: farm.region,
          regionFullName: farm.regionFullName,
          signalType: farm.signalType,
        };
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
      query: t.Object({
        publicKey: t.Optional(t.String()),
        shortId: t.Optional(t.String()),
        farmId: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get region info for a device or farm",
        description: `Returns the region, regionFullName, signalType, and farmId for a device (by publicKey or shortId) or a farm (by farmId). If multiple params are provided, prioritizes: publicKey > shortId > farmId.`,
        tags: [TAG.FARMS],
      },
    }
  )
  // .get("/reset-farms-names", async ({ set }) => {
  //   try {
  //     await db.update(farms).set({ name: "__UNSET__" });
  //     return { success: true };
  //   } catch (e) {
  //     if (e instanceof Error) {
  //       set.status = 400;
  //       return e.message;
  //     }
  //     set.status = 500;
  //     return "Internal Server Error";
  //   }
  // })
  .get(
    "/random-farm-name",
    async ({ set, query }) => {
      try {
        const { applicationId } = query;
        if (!applicationId) {
          set.status = 400;
          return { error: "applicationId is required" };
        }
        const name = await getUniqueStarNameForApplicationId(applicationId);
        if (name) return { name };
        set.status = 409;
        return {
          error: "Could not find a unique star name after several attempts",
        };
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
      query: t.Object({
        applicationId: t.String(),
      }),
      detail: {
        summary:
          "Get a deterministic unique farm name for a farm by applicationId",
        description: `Fetches a deterministic farm name from a static list using the applicationId and ensures it is not already used in the farms table.`,
        tags: [TAG.FARMS],
      },
    }
  )
  .get(
    "/patch-unset-names",
    async ({ set }) => {
      try {
        // 1. Find all farms with name '__UNSET__'
        const unsetFarms = await db.query.farms.findMany({
          where: (farms, { eq }) => eq(farms.name, "__UNSET__"),
          columns: { id: true },
          with: {
            application: {
              columns: { id: true },
            },
          },
        });

        if (!unsetFarms.length) return { updated: 0, farms: [] };

        const updatedFarms: { id: string; name: string }[] = [];

        for (const farm of unsetFarms) {
          let uniqueId = farm.application?.id;
          if (!uniqueId) {
            uniqueId = farm.id;
          }

          const name = await getUniqueStarNameForApplicationId(uniqueId);
          if (name) {
            await db.update(farms).set({ name }).where(eq(farms.id, farm.id));
            updatedFarms.push({ id: farm.id, name });
          } else {
            console.error(
              `[farmsRouter] Could not find unique star name for farm ${farm.id}`
            );
          }
        }

        return { updated: updatedFarms.length, farms: updatedFarms };
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
        summary:
          "Patch all farms with the default name __UNSET__ to a unique farm name",
        description: `Finds all farms with the name __UNSET__ and updates them to a unique farm name from a static list, using the applicationId for deterministic selection. Skips any that cannot be updated after 5 attempts. Returns a summary of updated farms.`,
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
      .get(
        "/my-farms", // Get all farms for the authenticated user
        async ({ set, userId }) => {
          try {
            const userFarms = await findFarmsByUserId(userId);
            return {
              farms: userFarms,
              total: userFarms.length,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[farmsRouter] /my-farms", e);
            set.status = 500;
            return "Internal Server Error";
          }
        },
        {
          detail: {
            summary: "Get all farms for the authenticated user",
            description:
              "Returns all farms owned by the authenticated user with their details, devices, and application information",
            tags: [TAG.FARMS],
          },
        }
      )
  );
