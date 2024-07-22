import { Elysia, NotFoundError, ParseError, ValidationError } from "elysia";
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
import {
  MigrationFarmData,
  insertFarmWithDependencies,
} from "./db/scripts/farm-migration";
import LegacyFarmsData from "./db/scripts/legacy-farms.json";
import { organizationsRouter } from "./routers/organizations-router/organizationsRouter";
import { permissions } from "./types/api-types/Permissions";
import { findAllPermissions } from "./db/queries/permissions/findAllPermissions";
import { createPermission } from "./db/mutations/permissions/createPermission";
import { legacyFarms } from "./legacy/farms";

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
  // .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(
    cron({
      name: "Updating Rewards",
      pattern: Patterns.everyHours(2),
      async run() {
        const currentWeek = getProtocolWeek();
        const weekToQuery = currentWeek - 1;
        // Make sure to keep updateWalletRewardsForWeek before updateFarmRewardsForWeek
        // Update Wallet Rewards For Week checks the merkle tree for the previous week
        // We don't want to update the farm rewards for the current week if a GCA hasn;t submitted the report yet.
        try {
          const keepGoing = await updateWalletRewardsForWeek(weekToQuery);
          if (!keepGoing.keepGoing) {
            console.log(
              `Already Updated Wallet Rewards for week ${weekToQuery}`
            );
            return;
          }
          await updateFarmRewardsForWeek({ weekNumber: weekToQuery });
        } catch (error) {
          console.error("Error updating rewards", error);
        }
      },
    })
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
  .get("/update-rewards-for-current-week", async () => {
    //Will only work if the GCA has submitted the report for the current week.
    const currentWeek = getProtocolWeek();
    try {
      await updateWalletRewardsForWeek(currentWeek);
      await updateFarmRewardsForWeek({ weekNumber: currentWeek });
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
    const lastWeek = getProtocolWeek() - 2;
    try {
      for (let i = 12; i <= lastWeek; i++) {
        await updateWalletRewardsForWeek(i);
        await updateFarmRewardsForWeek({ weekNumber: i });
      }
      return { message: "success" };
    } catch (error) {
      console.error("Error updating rewards", error);
      return { message: "error" };
    }
  })
  .get("/migrate-farms", async () => {
    const farmsData: MigrationFarmData[] = LegacyFarmsData.map((farm) => ({
      ...farm,
      old_short_ids: (farm.old_short_ids || []).map((shortId) =>
        shortId.toString()
      ),
    }));

    try {
      for (const farmData of farmsData) {
        await insertFarmWithDependencies(farmData);
      }
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
