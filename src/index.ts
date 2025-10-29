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
import { legacyFarms } from "./legacy/farms";
// import { farmsRouter } from "./routers/farms/farmsRouter";
import { updateDeviceRewardsForWeek } from "./crons/update-farm-rewards/update-device-rewards-for-week";
import { farmsRouter } from "./routers/farms/farmsRouter";
import { postMerkleRootHandler } from "./utils/postMerkleRoot";
import { getDevicesLifetimeMetrics } from "./crons/update-farm-rewards/get-devices-lifetime-metrics";

import { adminRouter } from "./routers/admin-router/adminRouter";
import { zonesRouter } from "./routers/zones/zonesRouter";
import { fractionsRouter } from "./routers/fractions-router/fractionsRouter";
import { incrementStaleFractions } from "./crons/increment-stale-fractions/incrementStaleFractions";
import { expireFractions } from "./crons/expire-fractions/expireFractions";
import { initializeFractionEventService } from "./services/eventListener";
import { retryFailedOperations } from "./services/retryFailedOperations";
import { createSlackClient } from "./slack/create-slack-client";

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
  .use(
    cron({
      name: "Increment Stale Fractions",
      pattern: "*/5 * * * *", // Every 5 minutes
      async run() {
        try {
          const result = await incrementStaleFractions();
          if (result.updated > 0) {
            console.log(
              `[Cron] Increment Stale Fractions: Updated ${result.updated} fractions`
            );
          }
        } catch (error) {
          console.error("[Cron] Error in Increment Stale Fractions:", error);
        }
      },
    })
  )
  .use(
    cron({
      name: "Expire Fractions",
      pattern: "0 * * * *", // Every hour
      async run() {
        try {
          const result = await expireFractions();
          console.log(
            `[Cron] Expire Fractions: Expired ${result.expired} fractions`
          );
        } catch (error) {
          console.error("[Cron] Error in Expire Fractions:", error);
        }
      },
    })
  )
  .use(
    cron({
      name: "Retry Failed Operations",
      pattern: "*/15 * * * *", // Every 15 minutes
      async run() {
        try {
          const result = await retryFailedOperations();
          console.log(
            `[Cron] Retry Failed Operations: ${result.retried} retried, ${result.resolved} resolved, ${result.failed} failed`
          );
        } catch (error) {
          console.error("[Cron] Error in Retry Failed Operations:", error);
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
  .get(
    "/trigger-increment-stale-fractions-cron",
    async ({
      store: {
        cron: { "Increment Stale Fractions": cronJob },
      },
    }) => {
      await cronJob.trigger();
      return { message: "success" };
    }
  )
  .get(
    "/trigger-expire-fractions-cron",
    async ({
      store: {
        cron: { "Expire Fractions": cronJob },
      },
    }) => {
      await cronJob.trigger();
      return { message: "success" };
    }
  )
  .get(
    "/trigger-retry-failed-operations-cron",
    async ({
      store: {
        cron: { "Retry Failed Operations": cronJob },
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
  .use(adminRouter)
  .use(zonesRouter)
  .use(fractionsRouter)
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
  .get("/legacyFarms", async () => {
    return legacyFarms;
  })
  .get("/", () => "Hey!")
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

// Initialize Slack bot
let slackBot: ReturnType<typeof createSlackClient> | undefined;
if (process.env.SLACK_BOT_TOKEN) {
  slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);
  slackBot.start();
  console.log("✅ Slack bot initialized");
}

// Initialize and start the fraction event service
if (
  process.env.RABBITMQ_ADMIN_USER &&
  process.env.RABBITMQ_ADMIN_PASSWORD &&
  process.env.RABBITMQ_QUEUE_NAME &&
  process.env.NODE_ENV
) {
  if (process.env.NODE_ENV === "staging" || process.env.RUN_LOCAL === "true") {
    console.log(
      "⚠️ Fraction event service not initialized - staging environment"
    );
  } else {
    const fractionEventService = initializeFractionEventService();

    fractionEventService
      .startListener()
      .then(() => {
        console.log("✅ Fraction event service started successfully");
      })
      .catch((error) => {
        console.error("❌ Failed to start fraction event service:", error);
      });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("Shutting down gracefully...");
      await fractionEventService.stopListener();
      await fractionEventService.disconnect();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("Shutting down gracefully...");
      await fractionEventService.stopListener();
      await fractionEventService.disconnect();
      process.exit(0);
    });
  }
} else {
  console.warn(
    "⚠️ Fraction event service not initialized - missing environment variables (RABBITMQ_ADMIN_USER, RABBITMQ_ADMIN_PASSWORD, RABBITMQ_QUEUE_NAME)"
  );
}

export type ApiType = typeof app;
