import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { protocolFeeRouter } from "./routers/protocol-fee-router/protocolFeeRouter";
import { rewardsRouter } from "./routers/rewards-router/rewardsRouter";
import { userWeeklyReward, users } from "./db/schema";
import { db } from "./db/db";
import { updateUserRewardsForWeek } from "./crons/update-user-rewards/update-user-rewards-for-week";
import { updateFarmRewardsForWeek } from "./crons/update-farm-rewards/update-farm-rewards-for-week";
import { accountsRouter } from "./routers/accounts-router/accountsRouter";
import { gcasRouter } from "./routers/gcas/gcasRouter";
import { farmOwnersRouter } from "./routers/farm-owners/farmOwnersRouter";
import { applicationsRouter } from "./routers/applications-router/applicationsRouter";

const PORT = process.env.PORT || 3005;
const app = new Elysia()
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(protocolFeeRouter)
  .use(rewardsRouter)
  .use(accountsRouter)
  .use(gcasRouter)
  .use(applicationsRouter)
  .use(farmOwnersRouter)
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
        await updateUserRewardsForWeek(i);
      }
      return { message: "success" };
    } catch (e) {
      console.log(e);
      return { error: true };
    }
  })
  .get("/delete", async () => {
    await db.delete(users);
    await db.delete(userWeeklyReward);
    return { deletion: "success" };
  })
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

export type ApiType = typeof app;
