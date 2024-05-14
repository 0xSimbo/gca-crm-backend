import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import { walletWeeklyRewards, wallets, farms } from "../../db/schema";
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
      const wallet = await db.query.wallets.findFirst({
        where: eq(wallets.id, body.wallet),
        with: {
          weeklyRewards: {
            where: inArray(walletWeeklyRewards.weekNumber, body.weekNumbers),
          },
        },
      });

      if (!wallet) throw new Error("Wallet Is Not Found");
      const userSerialized = {
        id: wallet.id,
        totalUSDGRewards: formatUnits(wallet.totalUSDGRewards, 2),
        totalGlowRewards: formatUnits(wallet.totalGlowRewards, 2),
        weeklyRewards: wallet.weeklyRewards.map((r) => {
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
      console.log("[rewardsRouter] wallet-rewards", e);
      throw new Error("Error Occured");
    }
  },
  {
    body: GetUserRewardsQueryBody,
    detail: {
      summary: "Find Rewards Information For Farms",
      description: `This route takes in a wallet address and an array of week numbers and returns the rewards information for the wallet. This includes the total USDG and GLOW rewards, as well as the rewards for each week in the array. It also includes the proof that the farms need to claim from the on-chain merkle root.`,
      tags: [TAG.REWARDS],
    },
  }
);
