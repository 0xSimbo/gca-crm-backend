import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import { userWeeklyReward, users } from "../../db/schema";
import { formatUnits } from "viem";

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
      totalUSDGRewards: formatUnits(user.totalUSDGRewards, 2),
      totalGlowRewards: formatUnits(user.totalGlowRewards, 2),
      weeklyRewards: user.weeklyRewards.map((r) => {
        return {
          weekNumber: r.weekNumber,
          usdgWeight: r.usdgWeight.toString(),
          glowWeight: r.glowWeight.toString(),
          usdgRewards: formatUnits(r.usdgRewards, 2),
          glowRewards: formatUnits(r.glowRewards, 2),
          indexInReports: r.indexInReports,
          claimProof: r.claimProof,
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
