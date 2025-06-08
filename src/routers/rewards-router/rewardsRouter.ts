import { Elysia, t } from "elysia";
import { db } from "../../db/db";
import { eq, inArray } from "drizzle-orm";
import { walletWeeklyRewards, wallets, deviceRewards } from "../../db/schema";
import { formatUnits, checksumAddress } from "viem";
import { TAG } from "../../constants";
import { getHexPubkeyFromShortId } from "../../utils/getHexPubkeyFromShortId";
import { getProtocolWeek } from "../../utils/getProtocolWeek";
import { getAllHexkeysAndShortIds } from "../../utils/getAllHexkeysAndShortIds";

const DEFAULT_PAGE_SIZE = 100;

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
    "/all-device-rewards",
    async ({ query }) => {
      try {
        const rewards = await db.query.deviceRewardParent.findMany({
          with: {
            deviceRewards: {
              columns: {
                weekNumber: true,
                glowRewards: true,
                usdgRewards: true,
              },
            },
          },
        });

        if (query.includeShortIds === "true") {
          const allKeys: { pubkey: `0x${string}`; shortId: number }[] =
            await getAllHexkeysAndShortIds();
          console.log(allKeys);

          const rewardsWithShortIds = rewards.map((r) => {
            const shortId = allKeys.find((k) => k.pubkey === r.id)?.shortId;
            return {
              ...r,
              shortId,
            };
          });

          return rewardsWithShortIds;
        }
        return rewards;
      } catch (e) {
        console.log("[rewardsRouter] all-device-rewards", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        includeShortIds: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get All Device Rewards",
        description: `This route returns all the device rewards for all the farms in the system.`,
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
      detail: {
        summary: "Get Device Rewards",
        description: `This route takes in a short ID and returns the rewards information for the device. This includes the lifetime GLOW and USDG rewards, as well as the rewards for the last week, last month, and last year. It also includes the rewards for each week in the array.`,
        tags: [TAG.REWARDS],
      },
      query: t.Object({
        shortId: t.String({
          minLength: 1,
          maxLength: 42,
        }),
      }),
    }
  )
  .get(
    "/weekly-device-rewards",
    async ({ query }) => {
      try {
        const weekNumber = Number(query.weekNumber);
        if (isNaN(weekNumber)) {
          throw new Error("Invalid Week Number");
        }

        const rewards = await db.query.deviceRewards.findMany({
          where: eq(deviceRewards.weekNumber, weekNumber),
        });

        const allKeys = await getAllHexkeysAndShortIds();

        const serializedRewards = rewards.map((reward) => {
          const shortId = allKeys.find(
            (k) => k.pubkey === reward.hexlifiedFarmPubKey
          )?.shortId;

          return {
            shortId,
            hexPubkey: reward.hexlifiedFarmPubKey,
            glowRewards: Number(reward.glowRewards),
            usdgRewards: Number(reward.usdgRewards),
            weekNumber: reward.weekNumber,
          };
        });

        return {
          weekNumber,
          devices: serializedRewards,
          totalDevices: serializedRewards.length,
          totalGlowRewards: serializedRewards.reduce(
            (acc, cur) => acc + cur.glowRewards,
            0
          ),
          totalUsdgRewards: serializedRewards.reduce(
            (acc, cur) => acc + cur.usdgRewards,
            0
          ),
        };
      } catch (e) {
        console.log("[rewardsRouter] weekly-device-rewards", e);
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        weekNumber: t.String(),
      }),
      detail: {
        summary: "Get All Device Rewards for a Specific Week",
        description:
          "Returns all device rewards for a given protocol week number, including total rewards and device count",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/wallet-rewards",
    async ({ query, set }) => {
      try {
        // Ensure wallet address is checksummed
        let checksummedWallet: string;
        try {
          const checksummed = checksumAddress(query.wallet as `0x${string}`);
          if (
            typeof checksummed === "string" &&
            checksummed.startsWith("0x") &&
            checksummed.length === 42
          ) {
            checksummedWallet = checksummed;
          } else {
            throw new Error();
          }
        } catch (err) {
          throw new Error("Invalid wallet address format");
        }
        const wallet = await db.query.wallets.findFirst({
          where: eq(wallets.id, checksummedWallet),
          with: {
            weeklyRewards: true,
          },
        });

        if (!wallet) {
          set.status = 404;
          return {
            error: "Wallet not found",
          };
        }

        const userSerialized = {
          id: wallet.id,
          totalUSDGRewards: formatUnits(wallet.totalUSDGRewards, 2),
          totalGlowRewards: formatUnits(wallet.totalGlowRewards, 2),
          weeklyRewards: wallet.weeklyRewards.map((r) => ({
            weekNumber: r.weekNumber,
            usdgWeight: r.usdgWeight.toString(),
            glowWeight: r.glowWeight.toString(),
            usdgRewards: formatUnits(r.usdgRewards, 2),
            glowRewards: formatUnits(r.glowRewards, 2),
            indexInReports: r.indexInReports,
            claimProof: r.claimProof,
          })),
        };
        return userSerialized;
      } catch (e) {
        console.log("[rewardsRouter] get-wallet-rewards", e);
        throw new Error(
          e instanceof Error
            ? e.message
            : "Error occurred while fetching wallet rewards"
        );
      }
    },
    {
      query: t.Object({
        wallet: t.String({
          minLength: 42,
          maxLength: 42,
          pattern: "^0x[a-fA-F0-9]{40}$", // 42 characters, starting with 0x and 40 hex digits
        }),
      }),
      detail: {
        summary: "Get All Rewards For a Wallet",
        description:
          "Returns all rewards information for a given wallet address, including total USDG and GLOW rewards and complete weekly reward history.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/wallets",
    async ({ query, set }) => {
      try {
        // Parse and validate pagination params
        const page = Number(query.page) > 0 ? Number(query.page) : 1;
        const pageSize =
          Number(query.pageSize) > 0
            ? Number(query.pageSize)
            : DEFAULT_PAGE_SIZE;
        const offset = (page - 1) * pageSize;
        const omitWeeklyRewards = query.omitWeeklyRewards === "true";

        // Get total wallet count
        const allWallets = await db.select().from(wallets);
        const totalCount = allWallets.length;

        // Always fetch weeklyRewards for type safety
        const walletsResult = await db.query.wallets.findMany({
          limit: pageSize,
          offset,
          with: {
            weeklyRewards: true,
          },
        });

        const walletList = walletsResult.map((wallet) => {
          const base = {
            id: wallet.id,
            totalUSDGRewards: formatUnits(wallet.totalUSDGRewards, 2),
            totalGlowRewards: formatUnits(wallet.totalGlowRewards, 2),
          };
          if (omitWeeklyRewards) return base;
          return {
            ...base,
            weeklyRewards: wallet.weeklyRewards.map((r: any) => ({
              weekNumber: r.weekNumber,
              usdgWeight: r.usdgWeight.toString(),
              glowWeight: r.glowWeight.toString(),
              usdgRewards: formatUnits(r.usdgRewards, 2),
              glowRewards: formatUnits(r.glowRewards, 2),
              indexInReports: r.indexInReports,
              claimProof: r.claimProof,
            })),
          };
        });

        return {
          wallets: walletList,
          totalCount,
          page,
          pageSize,
        };
      } catch (e) {
        set.status = 500;
        return {
          error:
            e instanceof Error
              ? e.message
              : "Error occurred while fetching wallets",
        };
      }
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
        omitWeeklyRewards: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get paginated wallets with rewards and total count",
        description:
          "Returns paginated wallets with their rewards and the total wallet count. Set omitWeeklyRewards=true to omit the weeklyRewards array.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/weekly-wallets",
    async ({ query, set }) => {
      try {
        const weekNumber = Number(query.weekNumber);
        if (isNaN(weekNumber)) {
          set.status = 400;
          return { error: "Invalid or missing weekNumber" };
        }
        const page = Number(query.page) > 0 ? Number(query.page) : 1;
        const pageSize =
          Number(query.pageSize) > 0
            ? Number(query.pageSize)
            : DEFAULT_PAGE_SIZE;
        const offset = (page - 1) * pageSize;

        // Get all weekly rewards for the week
        const allWeeklyRewards = await db.query.walletWeeklyRewards.findMany({
          where: eq(walletWeeklyRewards.weekNumber, weekNumber),
        });
        const totalCount = allWeeklyRewards.length;
        const paginatedWeeklyRewards = allWeeklyRewards.slice(
          offset,
          offset + pageSize
        );

        // Compose response
        const wallets = paginatedWeeklyRewards.map((reward) => ({
          id: reward.id,
          weeklyReward: {
            weekNumber: reward.weekNumber,
            usdgWeight: reward.usdgWeight.toString(),
            glowWeight: reward.glowWeight.toString(),
            usdgRewards: formatUnits(reward.usdgRewards, 2),
            glowRewards: formatUnits(reward.glowRewards, 2),
            indexInReports: reward.indexInReports,
            claimProof: reward.claimProof,
          },
        }));

        return {
          wallets,
          totalCount,
          page,
          pageSize,
        };
      } catch (e) {
        set.status = 500;
        return {
          error:
            e instanceof Error
              ? e.message
              : "Error occurred while fetching weekly wallets",
        };
      }
    },
    {
      query: t.Object({
        weekNumber: t.String(),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get all wallets with a weekly reward for a specific week",
        description:
          "Returns all wallets that have a weekly reward for the given week, with pagination.",
        tags: [TAG.REWARDS],
      },
    }
  )
  .get(
    "/wallet-reward-splits-and-farm-rewards",
    async ({ query, set }) => {
      try {
        const wallet = query.wallet;
        if (!wallet || typeof wallet !== "string" || wallet.length !== 42) {
          set.status = 400;
          return { error: "Invalid wallet address" };
        }

        const checksummedWallet = checksumAddress(wallet as `0x${string}`);

        // 2. Get all RewardSplits where walletAddress matches
        const rewardSplits = await db.query.RewardSplits.findMany({
          where: (RewardSplits, { eq }) =>
            eq(RewardSplits.walletAddress, checksummedWallet),
          with: {
            farm: {
              columns: {
                id: true,
                userId: true,
                auditCompleteDate: true,
              },
              with: {
                farmRewards: true,
                devices: {
                  columns: {
                    shortId: true,
                    isEnabled: true,
                  },
                },
              },
            },
          },
        });

        return {
          rewardSplits: rewardSplits.map(({ farm, ...split }) => {
            return {
              ...split,
              farm: {
                ...farm,
                farmRewards: farm?.farmRewards.map((r) => {
                  return {
                    ...r,
                    usdgRewards: formatUnits(r.usdgRewards, 2),
                    glowRewards: formatUnits(r.glowRewards, 2),
                  };
                }),
              },
            };
          }),
        };
      } catch (e) {
        set.status = 400;
        console.log("[rewardsRouter] wallet-reward-splits-and-farm-rewards", e);
        return {
          error: e instanceof Error ? e.message : "Unknown error",
        };
      }
    },
    {
      query: t.Object({
        wallet: t.String({ minLength: 42, maxLength: 42 }),
      }),
      detail: {
        summary:
          "Get all RewardSplits for a wallet and all farmRewards for their farms",
        description:
          "Returns all RewardSplits where walletAddress matches the given wallet, and all farmRewards for farms owned by the wallet.",
        tags: [TAG.REWARDS],
      },
    }
  );

const isNumber = (val: string) => {
  return !isNaN(Number(val));
};
