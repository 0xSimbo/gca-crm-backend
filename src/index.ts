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
import { cron, Patterns } from "@elysiajs/cron";
import { getProtocolWeek } from "./utils/getProtocolWeek";

const PORT = process.env.PORT || 3005;
const app = new Elysia()
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
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
        await updateWalletRewardsForWeek(weekToQuery);
        await updateFarmRewardsForWeek({ weekNumber: weekToQuery });
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
  .use(usersRouter)
  .get("/update-rewards-for-current-week", async () => {
    //Will only work if the GCA has submitted the report for the current week.
    const currentWeek = getProtocolWeek();
    await updateWalletRewardsForWeek(currentWeek);
    await updateFarmRewardsForWeek({ weekNumber: currentWeek });
    return { message: "success" };
  })
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

export type ApiType = typeof app;
