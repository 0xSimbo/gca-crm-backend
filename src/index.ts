import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { protocolFeeRouter } from "./routers/protocol-fee-router/protocolFeeRouter";
import { rewardsRouter } from "./routers/rewards-router/rewardsRouter";
import { walletWeeklyRewards, wallets } from "./db/schema";
import { db } from "./db/db";
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

const PORT = process.env.PORT || 3005;
const app = new Elysia()
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(protocolFeeRouter)
  .use(rewardsRouter)
  .use(accountsRouter)
  .use(installersRouter)
  .use(documentsRouter)
  .use(rewardSplitsRouter)
  .use(devicesRouter)
  .use(gcasRouter)
  .use(applicationsRouter)
  .use(usersRouter)
  .get("/", () => "Hello Elysia")
  .get("/farm-rewards", async () => {
    try {
      for (let i = 11; i < 23; ++i) {
        await updateFarmRewardsForWeek({ weekNumber: i });
      }
      return { message: "success" };
    } catch (e) {
      console.log(e);
      return { error: true };
    }
  })
  .get("/test-cron", async () => {
    try {
      for (let i = 10; i < 23; ++i) {
        await updateWalletRewardsForWeek(i);
      }
      return { message: "success" };
    } catch (e) {
      console.log(e);
      return { error: true };
    }
  })
  .get("/delete", async () => {
    await db.delete(wallets);
    await db.delete(walletWeeklyRewards);
    return { deletion: "success" };
  })
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

export type ApiType = typeof app;
