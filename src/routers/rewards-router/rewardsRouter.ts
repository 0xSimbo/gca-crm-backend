import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import {
  walletWeeklyRewards,
  wallets,
  farms,
  Devices,
  farmRewards,
  deviceRewards,
} from "../../db/schema";
import { formatUnits } from "viem";
import { TAG } from "../../constants";
import { getHexPubkeyFromShortId } from "../../utils/getHexPubkeyFromShortId";
import { getProtocolWeek } from "../../utils/getProtocolWeek";

export const GetUserRewardsQueryBody = t.Object({
  wallet: t.String({
    minLength: 42,
    maxLength: 42,
  }),
  weekNumbers: t.Array(t.Number()),
});

export const rewardsRouter = new Elysia({ prefix: "/rewards" })
  .post(
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
  )
  .get(
    "/device-rewards",
    async ({ query }) => {
      try {
        const shortId = query.shortId;
        if (!isNumber(shortId)) {
          throw new Error("Invalid ShortId");
        }
        // console.log({ shortId });

        console.log("I'm here wit short id = ", shortId);
        const hexlifiedPubkey = await getHexPubkeyFromShortId(shortId);
        if (!hexlifiedPubkey) {
          throw new Error("Invalid ShortId");
        }

        //log the hex pubkey
        console.log("hexlifiedPubkey", hexlifiedPubkey);
        const rewards = await db.query.deviceRewards.findMany({
          where: eq(deviceRewards.hexlifiedFarmPubKey, hexlifiedPubkey),
        });

        const lifetimeGlowEarned = rewards.reduce((acc, cur) => {
          return acc + Number(cur.glowRewards);
        }, 0);

        const lifetimeUSDGEarned = rewards.reduce((acc, cur) => {
          return acc + Number(cur.usdgRewards);
        }, 0);

        const currentProtooclWeek = getProtocolWeek();
        const amountMadeLastWeekOrNull = rewards.find(
          (r) => r.weekNumber === currentProtooclWeek - 1
        );

        const serializedRewards = rewards.map((r) => {
          return {
            weekNumber: r.weekNumber,
            glowRewards: Number(r.glowRewards),
            usdgRewards: Number(r.usdgRewards),
          };
        });

        const lastMonth = [
          currentProtooclWeek - 3,
          currentProtooclWeek - 2,
          currentProtooclWeek - 1,
          currentProtooclWeek,
        ];
        const lastMonthRewards = rewards.filter((r) =>
          lastMonth.includes(r.weekNumber)
        );
        const lastMonthGlow = lastMonthRewards.reduce(
          (acc, cur) => acc + Number(cur.glowRewards),
          0
        );
        const lastMonthUSDG = lastMonthRewards.reduce(
          (acc, cur) => acc + Number(cur.usdgRewards),
          0
        );

        const lastYear = Array.from(
          { length: 52 },
          (_, i) => currentProtooclWeek - i
        );
        const lastYearNoZeroes = lastYear.filter((n) => n >= 0);
        const lastYearRewards = rewards.filter((r) =>
          lastYearNoZeroes.includes(r.weekNumber)
        );
        const lastYearGlow = lastYearRewards.reduce(
          (acc, cur) => acc + Number(cur.glowRewards),
          0
        );
        const lastYearUSDG = lastYearRewards.reduce(
          (acc, cur) => acc + Number(cur.usdgRewards),
          0
        );

        return {
          lifetimeGlowEarned,
          lifetimeUSDGEarned,
          lastYearGlowEarned: lastYearGlow,
          lastYearUSDGEarned: lastYearUSDG,
          lastMonthGlowEarned: lastMonthGlow,
          lastMonthUSDGEarned: lastMonthUSDG,
          amountGlowEarnedLastWeek: Number(
            amountMadeLastWeekOrNull?.glowRewards || 0
          ),
          amountUSDGEarnedLastWeek: Number(
            amountMadeLastWeekOrNull?.usdgRewards || 0
          ),
          weeklyHistory: serializedRewards,
        };
      } catch (e) {
        console.log("[rewardsRouter] device-rewards", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        shortId: t.String({
          minLength: 1,
          maxLength: 42,
        }),
      }),
    }
  );

const isNumber = (val: string) => {
  return !isNaN(Number(val));
};
