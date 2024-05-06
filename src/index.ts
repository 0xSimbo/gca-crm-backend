// export type ApiType = typeof app;
import { buildSchema } from "drizzle-graphql";
import { db } from "./db/db";
import { apollo } from "@elysiajs/apollo";
import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { protocolFeeRouter } from "./routers/protocol-fee-router/protocolFeeRouter";
import { rewardsRouter } from "./routers/rewards-router/rewardsRouter";
import { userWeeklyReward, users } from "./db/schema";
import { updateUserRewardsForWeek } from "./crons/update-user-rewards/update-user-rewards-for-week";

const PORT = process.env.PORT || 4000;
const { schema } = buildSchema(db);

const app = new Elysia()
  // .onRequest(({ set, request }) => {
  //   //const headers
  //   const apiKey = request.headers.get("x-api-key");
  //   set.status = 401;
  //   return "Unauthorized";
  // })
  .use(apollo({ schema }))
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(protocolFeeRouter)
  .use(rewardsRouter)
  // .get("/", () => "HelloF Elysia")
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
