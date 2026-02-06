import { describe, expect, it, mock } from "bun:test";
import { getCurrentEpoch } from "../../src/utils/getProtocolWeek";
import {
  ENDOWMENT_WALLET,
  EXCLUDED_LEADERBOARD_WALLETS,
} from "../../src/constants/excluded-wallets";
import {
  formatPointsScaled6,
  glwWeiToPointsScaled6,
  GLW_DECIMALS,
} from "../../src/routers/impact-router/helpers/points";

const USER_WALLET = "0x1111111111111111111111111111111111111111";
const WEEK_NUMBER = getCurrentEpoch(Math.floor(Date.now() / 1000));

const TOTAL_GCTL_STAKED = 200n * GLW_DECIMALS;
const ENDOWMENT_STAKE = 60n * GLW_DECIMALS;
const OTHER_EXCLUDED_STAKE = 40n * GLW_DECIMALS;
const USER_STAKE = TOTAL_GCTL_STAKED - ENDOWMENT_STAKE - OTHER_EXCLUDED_STAKE;
const TOTAL_GLW_REWARD = 1000n * GLW_DECIMALS;
const STEERED_GLW_WEI =
  (TOTAL_GLW_REWARD * USER_STAKE) / TOTAL_GCTL_STAKED;

const OTHER_EXCLUDED_WALLET = EXCLUDED_LEADERBOARD_WALLETS.find(
  (wallet) => wallet !== ENDOWMENT_WALLET
)!;

const emptyQuery = {
  from() {
    return this;
  },
  innerJoin() {
    return this;
  },
  leftJoin() {
    return this;
  },
  where() {
    return Promise.resolve([] as any[]);
  },
  orderBy() {
    return this;
  },
  limit() {
    return Promise.resolve([] as any[]);
  },
  groupBy() {
    return this;
  },
};

mock.module("../../src/db/db", () => ({
  db: {
    select() {
      return emptyQuery;
    },
  },
}));

mock.module("../../src/constants/addresses", () => ({
  addresses: {
    glow: "0x0000000000000000000000000000000000000001",
  },
}));

mock.module("../../src/routers/impact-router/helpers/glw-balance", () => ({
  getLiquidGlwBalanceWei: async () => 0n,
}));

mock.module("../../src/routers/impact-router/helpers/control-api", () => ({
  fetchGlwBalanceSnapshotByWeekMany: async () => new Map(),
  fetchWalletRewardsHistoryBatch: async ({ wallets }: { wallets: string[] }) =>
    new Map(wallets.map((w) => [w.toLowerCase(), []])),
  fetchDepositSplitsHistoryBatch: async () => new Map(),
  fetchFarmRewardsHistoryBatch: async () => new Map(),
  fetchClaimedPdWeeksBatch: async () => new Map(),
  fetchClaimsBatch: async () => new Map(),
  fetchGlwHoldersFromPonder: async () => ({
    holders: [],
    topHoldersByBalance: [],
    totalCount: 0,
  }),
  fetchGctlStakersFromControlApi: async () => ({ stakers: [], totalCount: 0 }),
  fetchWalletStakeByEpochRange: async ({
    walletAddress,
    startWeek,
    endWeek,
  }: {
    walletAddress: string;
    startWeek: number;
    endWeek: number;
  }) => {
    const map = new Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>();
    if (walletAddress.toLowerCase() === ENDOWMENT_WALLET) {
      for (let w = startWeek; w <= endWeek; w++) {
        map.set(w, [{ regionId: 1, totalStakedWei: ENDOWMENT_STAKE }]);
      }
    }
    if (walletAddress.toLowerCase() === OTHER_EXCLUDED_WALLET) {
      for (let w = startWeek; w <= endWeek; w++) {
        map.set(w, [{ regionId: 1, totalStakedWei: OTHER_EXCLUDED_STAKE }]);
      }
    }
    return map;
  },
  getGctlSteeringByWeekWei: async ({
    startWeek,
    endWeek,
  }: {
    walletAddress: string;
    startWeek: number;
    endWeek: number;
  }) => {
    const byWeek = new Map<number, bigint>();
    const byWeekAndRegion = new Map<number, Map<number, bigint>>();
    for (let w = startWeek; w <= endWeek; w++) {
      byWeek.set(w, STEERED_GLW_WEI);
      byWeekAndRegion.set(w, new Map([[1, STEERED_GLW_WEI]]));
    }
    return { byWeek, byWeekAndRegion, dataSource: "control-api" as const };
  },
  getRegionRewardsAtEpoch: async ({ epoch }: { epoch: number }) => ({
    regionRewards: [
      {
        regionId: 1,
        glwReward: TOTAL_GLW_REWARD.toString(),
        gctlStaked: TOTAL_GCTL_STAKED.toString(),
      },
    ],
  }),
  getSteeringSnapshot: async () => ({
    steeredGlwWeiPerWeek: 0n,
    hasSteeringStake: false,
  }),
  getUnclaimedGlwRewardsWei: async () => ({
    amountWei: 0n,
    dataSource: "claims-api+control-api" as const,
  }),
}));

const { computeGlowImpactScores, applyMultiplierScaled6 } =
  await import("../../src/routers/impact-router/helpers/impact-score");

describe("impact steering boost", () => {
  it("boosts steering points as if endowment stake were excluded", async () => {
    const steeringPointsBaseScaled6 = glwWeiToPointsScaled6(
      STEERED_GLW_WEI,
      3_000_000n
    );
    const boostScaled6 = (TOTAL_GCTL_STAKED * 1_000_000n) / USER_STAKE;
    const steeringPointsBoostedScaled6 = applyMultiplierScaled6({
      pointsScaled6: steeringPointsBaseScaled6,
      multiplierScaled6: boostScaled6,
    });
    const expectedSteeringPoints = formatPointsScaled6(
      steeringPointsBoostedScaled6
    );

    const results = await computeGlowImpactScores({
      walletAddresses: [USER_WALLET],
      startWeek: WEEK_NUMBER,
      endWeek: WEEK_NUMBER,
      includeWeeklyBreakdown: false,
    });

    expect(results.length).toBe(1);
    const result = results[0]!;

    expect(result.totals.steeringPoints).toBe(expectedSteeringPoints);
    expect(result.totals.totalPoints).toBe(expectedSteeringPoints);
    expect(result.totals.totalSteeringGlwWei).toBe(
      STEERED_GLW_WEI.toString()
    );
  });
});
