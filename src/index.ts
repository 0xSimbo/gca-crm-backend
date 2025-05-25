import { Elysia, NotFoundError, ParseError, t, ValidationError } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { protocolFeeRouter } from "./routers/protocol-fee-router/protocolFeeRouter";
import { rewardsRouter } from "./routers/rewards-router/rewardsRouter";
import { updateFarmRewardsForWeek } from "./crons/update-farm-rewards/update-farm-rewards-for-week";
import { accountsRouter } from "./routers/accounts-router/accountsRouter";
import { gcasRouter } from "./routers/gcas-router/gcasRouter";
import { usersRouter } from "./routers/users-router/usersRouter";
import { applicationsRouter } from "./routers/applications-router/applicationsRouter";
import { updateWalletRewardsForWeek } from "./crons/update-wallet-rewards";
import { installersRouter } from "./routers/installers-router/installersRouter";
import { documentsRouter } from "./routers/documents-router/documentsRouter";
import { rewardSplitsRouter } from "./routers/reward-splits-router/rewardSplitsRouter";
import { devicesRouter } from "./routers/devices/devicesRouter";
import { cron, Patterns } from "@elysiajs/cron";
import { getProtocolWeek } from "./utils/getProtocolWeek";
import { organizationsRouter } from "./routers/organizations-router/organizationsRouter";
import { permissions } from "./types/api-types/Permissions";
import { findAllPermissions } from "./db/queries/permissions/findAllPermissions";
import { createPermission } from "./db/mutations/permissions/createPermission";
import { legacyFarms } from "./legacy/farms";
// import { farmsRouter } from "./routers/farms/farmsRouter";
import { updateDeviceRewardsForWeek } from "./crons/update-farm-rewards/update-device-rewards-for-week";
import { farmsRouter } from "./routers/farms/farmsRouter";
import { postMerkleRootHandler } from "./utils/postMerkleRoot";
import { getDevicesLifetimeMetrics } from "./crons/update-farm-rewards/get-devices-lifetime-metrics";
import { db } from "./db/db";
import {
  deviceRewards,
  farmRewards,
  farms,
  walletWeeklyRewards,
} from "./db/schema";

const PORT = process.env.PORT || 3005;
const app = new Elysia()
  .onError({ as: "global" }, ({ request, set, error, body }) => {
    if (error instanceof NotFoundError) {
      const pathname = new URL(request.url).pathname;
      const method = request.method;
      set.status = 404;
      return `Cannot ${method} ${pathname}`;
    }

    if (error instanceof ParseError) {
      set.status = 400;
      return `Invalid JSON`;
    }

    if (error instanceof ValidationError) {
      set.status = 422;
      const pathname = new URL(request.url).pathname;
      const validationError = error as ValidationError;
      console.error(
        "Validation Error at " + pathname,
        JSON.stringify(validationError.all[0])
      );

      return JSON.stringify(validationError.all[0]);
    }

    set.status = 500;
    return "Internal Server Error";
  })
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(
    cron({
      name: "Updating Rewards",
      pattern: Patterns.EVERY_WEEK,
      async run() {
        if (process.env.NODE_ENV === "production") {
          const currentWeek = getProtocolWeek();
          const weekToQuery = currentWeek - 1;
          const deviceLifetimeMetrics = await getDevicesLifetimeMetrics();
          // Make sure to keep updateWalletRewardsForWeek before updateFarmRewardsForWeek
          // Update Wallet Rewards For Week checks the merkle tree for the previous week
          // We don't want to update the farm rewards for the current week if a GCA hasn;t submitted the report yet.
          try {
            await updateDeviceRewardsForWeek({
              deviceLifetimeMetrics,
              weekNumber: weekToQuery,
            });
          } catch (e) {}
          try {
            const keepGoing = await updateWalletRewardsForWeek(weekToQuery);
            if (!keepGoing.keepGoing) {
              return;
            }
            await updateFarmRewardsForWeek({
              weekNumber: weekToQuery,
              deviceLifetimeMetrics,
            });
          } catch (error) {}
        }
      },
    })
  )
  .use(
    cron({
      name: "declaration-of-intention-merkle-root",
      pattern: Patterns.EVERY_WEEK,
      async run() {
        if (process.env.NODE_ENV === "production") {
          try {
            await postMerkleRootHandler();
          } catch (error) {
            if (error instanceof Error) {
              console.error("Error uploading merkle root", error.message);
              return error.message;
            } else {
              console.error("Error uploading merkle root");
              return "Error uploading merkle root";
            }
          }
        }
      },
    })
  )
  .get(
    "/trigger-merkle-root-cron",
    async ({
      store: {
        cron: { "declaration-of-intention-merkle-root": cronJob },
      },
    }) => {
      await cronJob.trigger();
      return { message: "success" };
    }
  )
  .use(protocolFeeRouter)
  .use(rewardsRouter)
  .use(accountsRouter)
  .use(installersRouter)
  .use(documentsRouter)
  .use(rewardSplitsRouter)
  .use(devicesRouter)
  .use(gcasRouter)
  .use(applicationsRouter)
  .use(organizationsRouter)
  .use(usersRouter)
  .use(farmsRouter)
  .get("/update-rewards-for-current-week", async () => {
    //Will only work if the GCA has submitted the report for the current week.
    const currentWeek = getProtocolWeek();
    try {
      const deviceLifetimeMetrics = await getDevicesLifetimeMetrics();
      await updateWalletRewardsForWeek(currentWeek);
      await updateFarmRewardsForWeek({
        deviceLifetimeMetrics,
        weekNumber: currentWeek,
      });
      return { message: "success" };
    } catch (error) {
      console.error("Error updating rewards", error);
      return { message: "error" };
    }
  })
  .get("/legacyFarms", async ({ params }) => {
    return legacyFarms;
  })
  .get("/update-rewards-for-all-weeks", async () => {
    return { message: "dev only" };
    const lastWeek = getProtocolWeek() - 1;
    try {
      await db.update(farms).set({
        totalUSDGRewards: BigInt(0),
        totalGlowRewards: BigInt(0),
      });
      await db.delete(farmRewards);
      await db.delete(deviceRewards);
      await db.delete(walletWeeklyRewards);
      const deviceLifetimeMetrics = await getDevicesLifetimeMetrics();
      for (let i = 10; i <= lastWeek; i++) {
        console.log("Updating rewards for week", i);
        await updateWalletRewardsForWeek(i);
        await updateDeviceRewardsForWeek({
          deviceLifetimeMetrics,
          weekNumber: i,
        });
        await updateFarmRewardsForWeek({
          deviceLifetimeMetrics,
          weekNumber: i,
        });
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error updating rewards", error);
      return { message: "error" };
    }
  })
  .get("/migrate-farms", async () => {
    // const farmsData: MigrationFarmData[] = LegacyFarmsData.map((farm) => ({
    //   ...farm,
    //   old_short_ids: (farm.old_short_ids || []).map((shortId) =>
    //     shortId.toString()
    //   ),
    // }));

    // try {
    //   for (const farmData of farmsData) {
    //     await insertFarmWithDependencies(farmData);
    //   }
    //   return { message: "success" };
    // } catch (error) {
    //   console.error("Error migrating farm", error);
    //   return { message: "error" };
    // }

    try {
      // console.log("Migrating farms coordinates");
      //   // hub farms
      //   const farmsData = await findAllFarmsCoordinates();
      //   // legacy farms
      //   // const farmsData = await findAllLegacyFarmsCoordinates();

      //   for (const farm of farmsData) {
      //     if (!farm.farmId) {
      //       console.log("No farm id found for farm", farm);
      //       continue;
      //     }
      //     if (
      //       farm.region !== "__UNSET__" &&
      //       farm.regionFullName !== "__UNSET__" &&
      //       farm.signalType !== "__UNSET__"
      //     ) {
      //       // console.log("Farm already has region", farm);
      //       continue;
      //     }
      //     const region = await getRegionFromLatAndLng(farm.lat, farm.lng);
      //     await updateFarmRegion(farm.farmId, region);
      //   }

      return { message: "success" };
    } catch (error) {
      console.error("Error migrating farm", error);
      return { message: "error" };
    }
  })
  .get("/seed-permissions", async () => {
    try {
      const dbPermissions = await findAllPermissions();
      if (dbPermissions.length > 0) {
        throw new Error("Permissions already seeded");
      }
      for (const permission of permissions) {
        await createPermission(permission);
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error seeding permissions", error);
      if (error instanceof Error) {
        return { message: error.message };
      }
      return { message: "error" };
    }
  })
  .get("/", () => "Hey!")
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

export type ApiType = typeof app;
