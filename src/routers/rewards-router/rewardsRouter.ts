import { Elysia, t } from "elysia";
import { db } from "@/db/db";
import { eq, inArray } from "drizzle-orm";
import { UserType, userWeeklyReward, users } from "@/db/schema";

export const GetUserRewardsQueryBody = t.Object({
  wallet: t.String({
    minLength: 42,
    maxLength: 42,
  }),
  weekNumbers: t.Array(t.Number()),
});
export const rewardsRouter = new Elysia({ prefix: "/rewards" }).post(
  "/user-rewards",
  async ({ body }) => {
    const user = await db.query.users.findFirst({
      where: eq(users.id, body.wallet),
      with: {
        weeklyRewards: {
          where: inArray(userWeeklyReward.weekNumber, body.weekNumbers),
        },
      },
    });

    if (!user) throw new Error("User Is Not Found");
    const userSerialized = {
      id: user.id,
      totalUSDGRewards: user.totalUSDGRewards.toString(),
      totalGlowRewards: user.totalGlowRewards.toString(),
      weeklyRewards: user.weeklyRewards.map((r) => {
        return {
          weekNumber: r.weekNumber,
          usdgWeight: r.usdgWeight.toString(),
          glowWeight: r.glowWeight.toString(),
          usdgRewards: r.usdgRewards.toString(),
          glowRewards: r.glowRewards.toString(),
          indexInReports: r.indexInReports,
        };
      }),
    };

    return userSerialized;
  },
  {
    body: GetUserRewardsQueryBody,
    detail: {
      summary: "A post route to get information regarding the user rewards",
      tags: ["rewards", "users", "usdg", "glow"],
    },
  },
);
