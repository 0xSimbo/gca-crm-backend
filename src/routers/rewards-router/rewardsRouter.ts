import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import { userWeeklyReward, users, Farms } from "../../db/schema";
import { formatUnits } from "viem";
import { TAG } from "../../constants";

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
    try {
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
    } catch (e) {
      console.log("[rewardsRouter] user-rewards", e);
      throw new Error("Error Occured");
    }
  },
  {
    body: GetUserRewardsQueryBody,
    detail: {
      summary: "Find Rewards Information For Farms",
      description: `This route takes in a wallet address and an array of week numbers and returns the rewards information for the user. This includes the total USDG and GLOW rewards, as well as the rewards for each week in the array. It also includes the proof that the farms need to claim from the on-chain merkle root.`,
      tags: [TAG.REWARDS],
    },
  }
);
