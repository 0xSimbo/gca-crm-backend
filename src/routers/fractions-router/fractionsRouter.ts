import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import {
  findFractionsByApplicationId,
  findFractionById,
  findActiveFractionByApplicationId,
  findMiningCenterFractionsByUserId,
} from "../../db/queries/fractions/findFractionsByApplicationId";
import {
  findFractionSplits,
  findSplitsByWalletAndFraction,
  findRecentSplitsActivity,
} from "../../db/queries/fractions/findFractionSplits";
import { findActiveDefaultMaxSplits } from "../../db/queries/defaultMaxSplits/findActiveDefaultMaxSplits";
import { findRefundableFractionsByWallet } from "../../db/queries/fractions/findRefundableFractions";
import { checksumAddress } from "viem";
import { createFraction } from "../../db/mutations/fractions/createFraction";
import { forwarderAddresses } from "../../constants/addresses";
import { getFractionsSummary } from "../../db/queries/fractions/getFractionsSummary";
import { getAvailableFractions } from "../../db/queries/fractions/getAvailableFractions";
import { getUniqueStarNameForApplicationId } from "../farms/farmsRouter";
import { getFarmNamesByApplicationIds } from "../../db/queries/farms/getFarmNamesByApplicationIds";
import { db } from "../../db/db";
import {
  fractions,
  fractionSplits,
  RewardSplits,
  applications,
} from "../../db/schema";
import { and, desc, eq, inArray, lte, sql, gt } from "drizzle-orm";
import { getCachedGlwSpotPriceNumber } from "../../utils/glw-spot";
import {
  getWeekRange,
  buildWalletFarmMap,
  aggregateRewardsByWallet,
  getEpochEndDate,
  getFilledFractionsUpToEpoch,
  calculateFractionTotals,
  type WalletFarmInfo,
} from "./helpers/apy-helpers";
import {
  calculateAccurateWalletAPY,
  getWalletFarmPurchases,
  getBatchWalletFarmPurchases,
  getPurchasesUpToWeek,
  getPurchasesAfterWeek,
  getBatchPurchasesUpToWeek,
  getBatchPurchasesAfterWeek,
  getFarmPurchasesAfterWeek,
} from "./helpers/accurate-apy-helpers";
import {
  getFilledStepStatsByFarm,
  getWalletPurchaseTypesByFarmUpToWeek,
} from "./helpers/per-piece-helpers";
import { FRACTION_STATUS } from "../../constants/fractions";
import {
  fetchWalletRewardsHistoryBatch,
  fetchWalletRewardsHistoryMany,
  fetchDepositSplitsHistoryBatch,
  fetchFarmRewardsHistoryBatch,
  type ControlApiDepositSplitHistorySegment,
  type ControlApiFarmRewardsHistoryRewardRow,
} from "../impact-router/helpers/control-api";

function parseOptionalBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function createRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export const fractionsRouter = new Elysia({ prefix: "/fractions" })
  .get(
    "/summary",
    async ({ set }) => {
      try {
        const summary = await getFractionsSummary();

        return summary;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /summary", e);
        throw new Error("Error Occured");
      }
    },
    {
      detail: {
        summary: "Get high-level fraction sales summary",
        description:
          "Returns totals for GLW delegated via launchpad fractions plus GLW from PayProtocolFee payments, and USD volume from mining-center fractions. Only filled fractions contribute to the totals.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/yield-per-100",
    async ({ query: { debug }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        const { startWeek, endWeek } = getWeekRange();
        const epochEndDate = getEpochEndDate(endWeek);

        const filled = await getFilledFractionsUpToEpoch(epochEndDate);
        const { totalGlwDelegated, totalMiningCenterVolume } =
          calculateFractionTotals(filled);

        const farmsByType = new Map<
          string,
          {
            hasLaunchpad: boolean;
            hasMiningCenter: boolean;
            launchpadSponsorSplitPercent: number;
            miningCenterSponsorSplitPercent: number;
            miningCenterTotalSteps: number;
            miningCenterSoldSteps: number;
          }
        >();

        const uniqueAppIds = Array.from(
          new Set(filled.map((f) => f.applicationId))
        );

        const appIdToFarmId = new Map<string, string>();
        const apps = await db.query.applications.findMany({
          columns: { id: true, farmId: true },
          where: (apps, { inArray }) => inArray(apps.id, uniqueAppIds),
        });

        for (const app of apps) {
          if (app.farmId) {
            appIdToFarmId.set(app.id, app.farmId);
          }
        }

        const allFractions = await db.query.fractions.findMany({
          columns: {
            applicationId: true,
            sponsorSplitPercent: true,
            type: true,
            totalSteps: true,
            splitsSold: true,
          },
          where: (fracs, { and, inArray, inArray: inArrayAlt }) =>
            and(
              inArray(fracs.applicationId, uniqueAppIds),
              inArrayAlt(fracs.status, [
                FRACTION_STATUS.FILLED,
                FRACTION_STATUS.EXPIRED,
              ])
            ),
        });

        const appIdToLaunchpadSplit = new Map<string, number>();
        const appIdToMiningCenterInfo = new Map<
          string,
          { sponsorSplitPercent: number; totalSteps: number; soldSteps: number }
        >();

        for (const frac of allFractions) {
          if (frac.type === "launchpad" && frac.sponsorSplitPercent !== null) {
            appIdToLaunchpadSplit.set(
              frac.applicationId,
              frac.sponsorSplitPercent
            );
          } else if (
            frac.type === "mining-center" &&
            frac.sponsorSplitPercent !== null
          ) {
            appIdToMiningCenterInfo.set(frac.applicationId, {
              sponsorSplitPercent: frac.sponsorSplitPercent,
              totalSteps: frac.totalSteps || 0,
              soldSteps: frac.splitsSold || 0,
            });
          }
        }

        for (const fraction of filled) {
          const farmId = appIdToFarmId.get(fraction.applicationId);
          if (!farmId) continue;

          const existing = farmsByType.get(farmId) || {
            hasLaunchpad: false,
            hasMiningCenter: false,
            launchpadSponsorSplitPercent: 0,
            miningCenterSponsorSplitPercent: 0,
            miningCenterTotalSteps: 0,
            miningCenterSoldSteps: 0,
          };

          if (fraction.type === "launchpad") {
            existing.hasLaunchpad = true;
            existing.launchpadSponsorSplitPercent =
              appIdToLaunchpadSplit.get(fraction.applicationId) || 0;
          } else if (fraction.type === "mining-center") {
            existing.hasMiningCenter = true;
            const mcInfo = appIdToMiningCenterInfo.get(fraction.applicationId);
            if (mcInfo) {
              existing.miningCenterSponsorSplitPercent =
                mcInfo.sponsorSplitPercent;
              existing.miningCenterTotalSteps = mcInfo.totalSteps;
              existing.miningCenterSoldSteps = mcInfo.soldSteps;
            }
          }

          farmsByType.set(farmId, existing);
        }

        const farmsWithLaunchpad = Array.from(farmsByType.entries())
          .filter(([_, types]) => types.hasLaunchpad)
          .map(([farmId, info]) => ({
            farmId,
            sponsorSplitPercent: info.launchpadSponsorSplitPercent,
          }));

        const farmsWithMiningCenter = Array.from(farmsByType.entries())
          .filter(([_, types]) => types.hasMiningCenter)
          .map(([farmId, info]) => ({
            farmId,
            sponsorSplitPercent: info.miningCenterSponsorSplitPercent,
            totalSteps: info.miningCenterTotalSteps,
            soldSteps: info.miningCenterSoldSteps,
          }));

        let totalGlwEarnedByDelegatorsLastWeek = BigInt(0);
        let totalGlwEarnedByMinersLastWeek = BigInt(0);

        const delegatorFarmBreakdown: Array<{
          farmId: string;
          farmName: string | null;
          sponsorSplitPercent: number;
          totalFarmInflation: string;
          totalFarmProtocolDeposit: string;
          delegatorInflationShare: string;
          sponsorInflationShare: string;
          delegatorProtocolDepositShare: string;
          totalDelegatorRewards: string;
        }> = [];

        const minerFarmBreakdown: Array<{
          farmId: string;
          farmName: string | null;
          sponsorSplitPercent: number;
          totalSteps: number;
          soldSteps: number;
          isPartiallyFilled: boolean;
          totalFarmInflation: string;
          totalFarmProtocolDeposit: string;
          minerInflationShare: string;
          minerProtocolDepositShare: string;
          totalMinerRewards: string;
        }> = [];

        const allUniqueFarmIds = new Set<string>();
        const launchpadFarmMap = new Map<
          string,
          (typeof farmsWithLaunchpad)[0]
        >();
        const miningCenterFarmMap = new Map<
          string,
          (typeof farmsWithMiningCenter)[0]
        >();

        for (const farm of farmsWithLaunchpad) {
          allUniqueFarmIds.add(farm.farmId);
          launchpadFarmMap.set(farm.farmId, farm);
        }
        for (const farm of farmsWithMiningCenter) {
          allUniqueFarmIds.add(farm.farmId);
          miningCenterFarmMap.set(farm.farmId, farm);
        }

        const allFarmIds = Array.from(allUniqueFarmIds);
        const batchSize = 500;

        for (let i = 0; i < allFarmIds.length; i += batchSize) {
          const batch = allFarmIds.slice(i, i + batchSize);

          try {
            const response = await fetch(
              `${process.env.CONTROL_API_URL}/farms/rewards-history/batch`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  farmIds: batch,
                  startWeek: endWeek,
                  endWeek: endWeek,
                }),
              }
            );

            if (response.ok) {
              const data: any = await response.json();
              const results = data.results || {};

              for (const farmId of batch) {
                const farmData = results[farmId];
                if (!farmData || farmData.error) continue;

                const weekRewards = farmData.rewards || [];
                for (const weekData of weekRewards) {
                  if (weekData.weekNumber !== endWeek) continue;

                  const totalInflation = BigInt(
                    weekData.glowInflationTotal || "0"
                  );
                  const depositReward = BigInt(
                    weekData.protocolDepositRewardsDistributed || "0"
                  );

                  const launchpadFarm = launchpadFarmMap.get(farmId);
                  if (launchpadFarm) {
                    const delegatorInflationShare =
                      (totalInflation *
                        BigInt(launchpadFarm.sponsorSplitPercent)) /
                      BigInt(100);
                    const sponsorInflationShare =
                      totalInflation - delegatorInflationShare;

                    const totalDelegatorRewards =
                      delegatorInflationShare + depositReward;

                    totalGlwEarnedByDelegatorsLastWeek += totalDelegatorRewards;

                    delegatorFarmBreakdown.push({
                      farmId: launchpadFarm.farmId,
                      farmName: weekData.farmName || farmData.farmName || null,
                      sponsorSplitPercent: launchpadFarm.sponsorSplitPercent,
                      totalFarmInflation: totalInflation.toString(),
                      totalFarmProtocolDeposit: depositReward.toString(),
                      delegatorInflationShare:
                        delegatorInflationShare.toString(),
                      sponsorInflationShare: sponsorInflationShare.toString(),
                      delegatorProtocolDepositShare: depositReward.toString(),
                      totalDelegatorRewards: totalDelegatorRewards.toString(),
                    });
                  }

                  const miningCenterFarm = miningCenterFarmMap.get(farmId);
                  if (miningCenterFarm) {
                    let minerInflationShare: bigint;
                    const isPartiallyFilled =
                      miningCenterFarm.totalSteps > 0 &&
                      miningCenterFarm.soldSteps < miningCenterFarm.totalSteps;

                    if (isPartiallyFilled) {
                      const fullSponsorShare =
                        (totalInflation *
                          BigInt(miningCenterFarm.sponsorSplitPercent)) /
                        BigInt(100);
                      minerInflationShare =
                        (fullSponsorShare *
                          BigInt(miningCenterFarm.soldSteps)) /
                        BigInt(miningCenterFarm.totalSteps);
                    } else {
                      minerInflationShare =
                        (totalInflation *
                          BigInt(miningCenterFarm.sponsorSplitPercent)) /
                        BigInt(100);
                    }

                    const minerProtocolDepositShare = BigInt(0);

                    const totalMinerRewards =
                      minerInflationShare + minerProtocolDepositShare;
                    totalGlwEarnedByMinersLastWeek += totalMinerRewards;

                    minerFarmBreakdown.push({
                      farmId: miningCenterFarm.farmId,
                      farmName: weekData.farmName || farmData.farmName || null,
                      sponsorSplitPercent: miningCenterFarm.sponsorSplitPercent,
                      totalSteps: miningCenterFarm.totalSteps,
                      soldSteps: miningCenterFarm.soldSteps,
                      isPartiallyFilled,
                      totalFarmInflation: totalInflation.toString(),
                      totalFarmProtocolDeposit: depositReward.toString(),
                      minerInflationShare: minerInflationShare.toString(),
                      minerProtocolDepositShare:
                        minerProtocolDepositShare.toString(),
                      totalMinerRewards: totalMinerRewards.toString(),
                    });
                  }
                }
              }
            }
          } catch (error) {
            console.error("Failed to fetch farm rewards:", error);
          }
        }

        const glwPerWeekPer100GlwDelegatedWei =
          totalGlwDelegated === BigInt(0)
            ? BigInt(0)
            : (totalGlwEarnedByDelegatorsLastWeek *
                BigInt(100) *
                BigInt(1_000_000_000_000_000_000)) /
              totalGlwDelegated;

        const glwPerWeekPer100UsdMinerWei =
          totalMiningCenterVolume === BigInt(0)
            ? BigInt(0)
            : (totalGlwEarnedByMinersLastWeek *
                BigInt(100) *
                BigInt(1_000_000)) /
              totalMiningCenterVolume;

        const includeDebug = debug === "true" || debug === "1";

        return {
          weekRange: {
            startWeek,
            endWeek,
          },
          metrics: {
            glwPerWeekPer100UsdMiner: glwPerWeekPer100UsdMinerWei.toString(),
            glwPerWeekPer100GlwDelegated:
              glwPerWeekPer100GlwDelegatedWei.toString(),
          },
          ...(includeDebug
            ? {
                totals: {
                  totalGlwDelegated: totalGlwDelegated.toString(),
                  totalUsdcSpentByMiners: totalMiningCenterVolume.toString(),
                  totalGlwEarnedByDelegatorsLastWeek:
                    totalGlwEarnedByDelegatorsLastWeek.toString(),
                  totalGlwEarnedByMinersLastWeek:
                    totalGlwEarnedByMinersLastWeek.toString(),
                  farmsWithLaunchpad: farmsWithLaunchpad.length,
                  farmsWithMiningCenter: farmsWithMiningCenter.length,
                },
                delegatorFarms: delegatorFarmBreakdown,
                minerFarms: minerFarmBreakdown,
              }
            : {}),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /yield-per-100", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        debug: t.Optional(
          t.String({
            description: "Include debug totals (true|1)",
          })
        ),
      }),
      detail: {
        summary: "Get GLW yield per week per $100 invested",
        description:
          "Returns GLW earned per week per $100 USD spent by miners and per 100 GLW delegated by delegators. Uses last completed week's rewards divided by total filled fractions up to that week. Metrics are returned in wei (18 decimals for GLW). Optional debug flag includes intermediate totals.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/average-apy",
    async ({ query: { debug, walletAddress, farmId }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        if (walletAddress && farmId) {
          set.status = 400;
          return "Cannot filter by both walletAddress and farmId";
        }

        if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
          set.status = 400;
          return "Invalid wallet address format";
        }

        const { startWeek, endWeek } = getWeekRange();
        const glwSpotPrice = await getCachedGlwSpotPriceNumber();

        const walletFarmMap = await buildWalletFarmMap();

        let walletsToProcess: string[] = [];
        if (walletAddress) {
          const walletLower = walletAddress.toLowerCase();
          if (!walletFarmMap.has(walletLower)) {
            set.status = 404;
            return "Wallet not found or has no associated farms";
          }
          walletsToProcess = [walletLower];
        } else if (farmId) {
          for (const [wallet, farms] of walletFarmMap) {
            if (farms.some((f) => f.farmId === farmId)) {
              walletsToProcess.push(wallet);
            }
          }
          if (walletsToProcess.length === 0) {
            set.status = 404;
            return "Farm not found or has no associated wallets";
          }
        } else {
          walletsToProcess = Array.from(walletFarmMap.keys());
        }

        const batchSize = 500;
        const allBatchRewards = new Map<string, any[]>();
        const allBatchPurchases = await getBatchWalletFarmPurchases(
          walletsToProcess
        );

        for (let i = 0; i < walletsToProcess.length; i += batchSize) {
          const batch = walletsToProcess.slice(i, i + batchSize);

          try {
            const response = await fetch(
              `${process.env.CONTROL_API_URL}/farms/by-wallet/farm-rewards-history/batch`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  wallets: batch,
                  startWeek,
                  endWeek,
                }),
              }
            );

            if (response.ok) {
              const data: any = await response.json();
              for (const wallet of batch) {
                const walletData = data.results?.[wallet];
                if (walletData?.farmRewards) {
                  allBatchRewards.set(wallet, walletData.farmRewards);
                }
              }
            }
          } catch (error) {
            console.error("Failed to fetch batch rewards:", error);
          }
        }

        const walletAPYResults: Array<{
          wallet: string;
          delegatorAPY: number;
          minerAPY: number;
          delegatorInvestment: bigint;
          minerInvestment: bigint;
        }> = [];

        for (const wallet of walletsToProcess) {
          const farmPurchases = allBatchPurchases.get(wallet) || [];
          const farmRewards = allBatchRewards.get(wallet) || [];

          if (farmPurchases.length === 0) {
            continue;
          }

          const apyData = await calculateAccurateWalletAPY(
            wallet,
            startWeek,
            endWeek,
            glwSpotPrice,
            farmRewards,
            farmPurchases
          );

          const delegatorInvestment = apyData.farmBreakdowns
            .filter((f) => f.type === "launchpad")
            .reduce((sum, f) => sum + f.amountInvested, BigInt(0));

          const minerInvestment = apyData.farmBreakdowns
            .filter((f) => f.type === "mining-center")
            .reduce((sum, f) => sum + f.amountInvested, BigInt(0));

          walletAPYResults.push({
            wallet,
            delegatorAPY: apyData.delegatorAPY,
            minerAPY: apyData.minerAPY,
            delegatorInvestment,
            minerInvestment,
          });
        }

        let totalDelegatorInvestment = BigInt(0);
        let totalMinerInvestment = BigInt(0);
        let weightedDelegatorAPY = 0;
        let weightedMinerAPY = 0;

        for (const result of walletAPYResults) {
          totalDelegatorInvestment += result.delegatorInvestment;
          totalMinerInvestment += result.minerInvestment;

          if (result.delegatorInvestment > BigInt(0)) {
            const weight =
              Number(result.delegatorInvestment) /
              Number(
                walletAPYResults.reduce(
                  (sum, r) => sum + r.delegatorInvestment,
                  BigInt(0)
                )
              );
            weightedDelegatorAPY += result.delegatorAPY * weight;
          }

          if (result.minerInvestment > BigInt(0)) {
            const weight =
              Number(result.minerInvestment) /
              Number(
                walletAPYResults.reduce(
                  (sum, r) => sum + r.minerInvestment,
                  BigInt(0)
                )
              );
            weightedMinerAPY += result.minerAPY * weight;
          }
        }

        const includeDebug = debug === "true" || debug === "1";

        return {
          startWeek,
          endWeek,
          ...(walletAddress
            ? { walletAddress: walletAddress.toLowerCase() }
            : {}),
          ...(farmId ? { farmId } : {}),
          totals: {
            totalGlwDelegated: totalDelegatorInvestment.toString(),
            totalUsdcSpentByMiners: totalMinerInvestment.toString(),
          },
          averageDelegatorApy: weightedDelegatorAPY.toFixed(4),
          averageMinerApyPercent: weightedMinerAPY.toFixed(4),
          ...(includeDebug
            ? {
                debug: {
                  dataSource: "accurate-wallet-apy-aggregation",
                  walletsProcessed: walletAPYResults.length,
                  totalWallets: walletsToProcess.length,
                },
              }
            : {}),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        debug: t.Optional(
          t.String({
            description: "Include debug Control API data (true|1)",
          })
        ),
        walletAddress: t.Optional(
          t.String({
            pattern: "^0x[a-fA-F0-9]{40}$",
            description: "Filter APY calculation to a specific wallet",
          })
        ),
        farmId: t.Optional(
          t.String({
            description: "Filter APY calculation to a specific farm",
          })
        ),
      }),
      detail: {
        summary: "Get Average Delegator and Miner APY",
        description:
          "Computes average APY metrics using actual wallet rewards from the Control API, from week 97 (first week of delegations) to the last completed epoch. Fetches rewards for all unique wallets with reward splits across all farms (or filtered by walletAddress/farmId), then aggregates by delegator/miner classification. Delegator APY = (total_glw_earned_by_all_delegators_last_week * 100) / total_glw_delegated_by_all_delegators. Miner APY = (((52.18 * total_usdc_earned_by_all_miners_last_week) / total_usdc_spent_by_all_miners) - 1) * 100. Uses Control API wallet rewards endpoint for accurate reward calculations. Optional walletAddress or farmId parameters filter the calculation to a specific wallet or farm.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/rewards-breakdown",
    async ({
      query: { walletAddress, farmId, startWeek, endWeek, debugTimings },
      set,
    }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        const shouldLogTimings = parseOptionalBool(debugTimings);
        const requestId = shouldLogTimings ? createRequestId() : null;
        const requestStartMs = nowMs();
        const timingEvents: Array<{
          label: string;
          ms: number;
          meta?: Record<string, unknown>;
        }> = [];
        const recordTiming = (
          label: string,
          startMs: number,
          meta?: Record<string, unknown>
        ) => {
          if (!shouldLogTimings) return;
          timingEvents.push({ label, ms: nowMs() - startMs, meta });
        };

        if (!walletAddress && !farmId) {
          set.status = 400;
          return "Either walletAddress or farmId must be provided";
        }

        if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
          set.status = 400;
          return "Invalid wallet address format";
        }

        const weekRange = getWeekRange();
        const actualStartWeek = startWeek
          ? parseInt(startWeek)
          : weekRange.startWeek;
        const actualEndWeek = endWeek ? parseInt(endWeek) : weekRange.endWeek;

        if (isNaN(actualStartWeek) || isNaN(actualEndWeek)) {
          set.status = 400;
          return "Invalid week range";
        }

        if (walletAddress) {
          const walletStartMs = nowMs();
          const walletLower = walletAddress.toLowerCase();
          const epochEndDate = getEpochEndDate(actualEndWeek);

          const fetchStartMs = nowMs();
          const DELEGATION_START_WEEK = 97;
          const [
            glwSpotPrice,
            rewardSplits,
            purchaseRows,
            walletRewardsMap,
            depositSplitSegments,
          ] = await Promise.all([
            getCachedGlwSpotPriceNumber(),
            (async () => {
              const t0 = nowMs();
              const rows = await db
                .select({
                  farmId: RewardSplits.farmId,
                })
                .from(RewardSplits)
                .where(
                  sql`lower(${RewardSplits.walletAddress}) = ${walletLower}`
                );
              recordTiming("rewardsBreakdown.db.rewardSplits", t0, {
                rows: rows.length,
              });
              return rows;
            })(),
            (async () => {
              const t0 = nowMs();
              const rows = await db
                .select({
                  amount: fractionSplits.amount,
                  stepsPurchased: fractionSplits.stepsPurchased,
                  createdAt: fractionSplits.createdAt,
                  fractionType: fractions.type,
                  applicationId: applications.id,
                  farmId: applications.farmId,
                })
                .from(fractionSplits)
                .innerJoin(
                  fractions,
                  eq(fractionSplits.fractionId, fractions.id)
                )
                .innerJoin(
                  applications,
                  eq(fractions.applicationId, applications.id)
                )
                .where(eq(fractionSplits.buyer, walletLower));
              recordTiming("rewardsBreakdown.db.purchases", t0, {
                rows: rows.length,
              });
              return rows;
            })(),
            (async () => {
              const t0 = nowMs();
              try {
                const m = await fetchWalletRewardsHistoryBatch({
                  wallets: [walletLower],
                  startWeek: actualStartWeek,
                  endWeek: actualEndWeek,
                });
                recordTiming(
                  "rewardsBreakdown.control.walletRewards.batch",
                  t0,
                  {
                    wallets: 1,
                    startWeek: actualStartWeek,
                    endWeek: actualEndWeek,
                  }
                );
                return m;
              } catch (error) {
                recordTiming(
                  "rewardsBreakdown.control.walletRewards.batch",
                  t0,
                  {
                    wallets: 1,
                    startWeek: actualStartWeek,
                    endWeek: actualEndWeek,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                );
                return new Map<string, any[]>();
              }
            })(),
            (async () => {
              const t0 = nowMs();
              try {
                const m = await fetchDepositSplitsHistoryBatch({
                  wallets: [walletLower],
                  startWeek: DELEGATION_START_WEEK,
                  endWeek: actualEndWeek,
                });
                recordTiming(
                  "rewardsBreakdown.control.depositSplits.batch",
                  t0,
                  {
                    wallets: 1,
                    startWeek: DELEGATION_START_WEEK,
                    endWeek: actualEndWeek,
                  }
                );
                return m.get(walletLower) || [];
              } catch (error) {
                recordTiming(
                  "rewardsBreakdown.control.depositSplits.batch",
                  t0,
                  {
                    wallets: 1,
                    startWeek: DELEGATION_START_WEEK,
                    endWeek: actualEndWeek,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                );
                return [] as ControlApiDepositSplitHistorySegment[];
              }
            })(),
          ]);
          recordTiming("rewardsBreakdown.fetch.all", fetchStartMs);

          const farmPurchaseMap = new Map<
            string,
            {
              farmId: string;
              appId: string;
              type: "launchpad" | "mining-center";
              amountInvested: bigint;
              stepsPurchased: number;
              isVaultOwnership?: boolean;
            }
          >();

          let totalGlwDelegated = BigInt(0);
          let totalUsdcSpent = BigInt(0);
          let totalGlwDelegatedAfter = BigInt(0);
          let totalUsdcSpentAfter = BigInt(0);

          const recentFarmTypesMap = new Map<
            string,
            Set<"launchpad" | "mining-center">
          >();

          for (const row of purchaseRows) {
            const farmId = row.farmId;
            if (!farmId) continue;
            const type =
              row.fractionType === "mining-center"
                ? "mining-center"
                : "launchpad";

            let amount = BigInt(0);
            try {
              amount = BigInt(row.amount);
            } catch {
              amount = BigInt(0);
            }
            const steps = row.stepsPurchased || 0;

            const key = `${farmId}-${type}`;
            const existing = farmPurchaseMap.get(key) || {
              farmId,
              appId: row.applicationId,
              type,
              amountInvested: BigInt(0),
              stepsPurchased: 0,
            };
            existing.amountInvested += amount;
            existing.stepsPurchased += steps;
            farmPurchaseMap.set(key, existing);

            const createdAt = row.createdAt;
            const isUpToWeek = createdAt ? createdAt <= epochEndDate : true;
            if (isUpToWeek) {
              if (type === "launchpad") totalGlwDelegated += amount;
              else totalUsdcSpent += amount;
            } else {
              if (type === "launchpad") totalGlwDelegatedAfter += amount;
              else totalUsdcSpentAfter += amount;
              if (!recentFarmTypesMap.has(farmId))
                recentFarmTypesMap.set(farmId, new Set());
              recentFarmTypesMap.get(farmId)!.add(type);
            }
          }

          // Process vault ownership (deposit splits) for farms not directly purchased
          const vaultFarmIds = new Set<string>();
          for (const seg of depositSplitSegments) {
            vaultFarmIds.add(seg.farmId);
          }

          // Remove farms already in farmPurchaseMap (we only add vault farms that weren't directly purchased)
          const directPurchaseFarmIds = new Set(
            Array.from(farmPurchaseMap.values()).map((p) => p.farmId)
          );
          const vaultOnlyFarmIds = Array.from(vaultFarmIds).filter(
            (id) => !directPurchaseFarmIds.has(id)
          );

          // Fetch principals and cumulative distributions for vault-only farms
          let vaultPrincipalByFarm = new Map<string, bigint>();
          let vaultAppIdByFarm = new Map<string, string>();
          let vaultCumulativeDistByFarm = new Map<string, bigint>();

          if (vaultOnlyFarmIds.length > 0) {
            const vaultT0 = nowMs();

            // Fetch farm principals from DB (GLW-paid applications only)
            const principalRows = await db
              .select({
                farmId: applications.farmId,
                appId: applications.id,
                paymentAmount: applications.paymentAmount,
              })
              .from(applications)
              .where(
                and(
                  inArray(applications.farmId, vaultOnlyFarmIds),
                  eq(applications.isCancelled, false),
                  eq(applications.status, "completed"),
                  eq(applications.paymentCurrency, "GLW")
                )
              );

            for (const row of principalRows) {
              if (!row.farmId) continue;
              const amountWei = BigInt(row.paymentAmount || "0");
              if (amountWei <= BigInt(0)) continue;
              vaultPrincipalByFarm.set(
                row.farmId,
                (vaultPrincipalByFarm.get(row.farmId) || BigInt(0)) + amountWei
              );
              if (!vaultAppIdByFarm.has(row.farmId)) {
                vaultAppIdByFarm.set(row.farmId, row.appId);
              }
            }

            // Fetch farm rewards history to calculate cumulative distributions
            const glwPrincipalFarmIds = vaultOnlyFarmIds.filter(
              (id) => (vaultPrincipalByFarm.get(id) || BigInt(0)) > BigInt(0)
            );

            if (glwPrincipalFarmIds.length > 0) {
              try {
                const farmRewardsMap = await fetchFarmRewardsHistoryBatch({
                  farmIds: glwPrincipalFarmIds,
                  startWeek: DELEGATION_START_WEEK,
                  endWeek: actualEndWeek,
                });

                // Calculate cumulative distributed for each farm
                for (const [farmId, rows] of farmRewardsMap) {
                  let cumulative = BigInt(0);
                  for (const r of rows) {
                    if ((r.paymentCurrency || "").toUpperCase() !== "GLW")
                      continue;
                    const distributed = BigInt(
                      r.protocolDepositRewardsDistributed || "0"
                    );
                    if (distributed > BigInt(0)) {
                      cumulative += distributed;
                    }
                  }
                  vaultCumulativeDistByFarm.set(farmId, cumulative);
                }
              } catch (error) {
                console.error("Failed to fetch farm rewards for vault:", error);
              }
            }

            recordTiming("rewardsBreakdown.vault.fetchPrincipals", vaultT0, {
              vaultFarms: vaultOnlyFarmIds.length,
              glwPrincipalFarms: glwPrincipalFarmIds.length,
            });

            // Calculate vault amountInvested and add to farmPurchaseMap
            const SPLIT_SCALE = BigInt(1_000_000);
            for (const seg of depositSplitSegments) {
              // Only process vault-only farms
              if (directPurchaseFarmIds.has(seg.farmId)) continue;

              const principalWei =
                vaultPrincipalByFarm.get(seg.farmId) || BigInt(0);
              if (principalWei <= BigInt(0)) continue;

              // Check if segment overlaps with query range (skip if no overlap)
              if (
                seg.endWeek < actualStartWeek ||
                seg.startWeek > actualEndWeek
              )
                continue;

              const splitScaled6 = BigInt(
                seg.depositSplitPercent6Decimals || "0"
              );
              if (splitScaled6 <= BigInt(0)) continue;

              const cumulativeDistributed =
                vaultCumulativeDistByFarm.get(seg.farmId) || BigInt(0);
              const remaining =
                principalWei > cumulativeDistributed
                  ? principalWei - cumulativeDistributed
                  : BigInt(0);
              const amountInvested = (remaining * splitScaled6) / SPLIT_SCALE;

              if (amountInvested <= BigInt(0)) continue;

              const key = `${seg.farmId}-launchpad-vault`;
              const existing = farmPurchaseMap.get(key);
              if (existing) {
                existing.amountInvested += amountInvested;
              } else {
                farmPurchaseMap.set(key, {
                  farmId: seg.farmId,
                  appId: vaultAppIdByFarm.get(seg.farmId) || "",
                  type: "launchpad",
                  amountInvested,
                  stepsPurchased: 0,
                  isVaultOwnership: true,
                });
              }

              // Add to totalGlwDelegated (vault ownership counts as delegation)
              totalGlwDelegated += amountInvested;
            }
          }

          const farmPurchases = Array.from(farmPurchaseMap.values());

          if (farmPurchases.length === 0) {
            const farmsWithSplits = new Set(
              rewardSplits
                .map((r) => r.farmId)
                .filter((id): id is string => id !== null)
            );

            if (farmsWithSplits.size === 0) {
              set.status = 404;
              return "Wallet not found or has no rewards";
            }
          }

          const farms = Array.from(new Set(farmPurchases.map((p) => p.farmId)));

          const farmPurchasesByFarmId = new Map<
            string,
            Set<"launchpad" | "mining-center">
          >();
          for (const purchase of farmPurchases) {
            if (!farmPurchasesByFarmId.has(purchase.farmId)) {
              farmPurchasesByFarmId.set(purchase.farmId, new Set());
            }
            farmPurchasesByFarmId.get(purchase.farmId)!.add(purchase.type);
          }

          let delegatorFarmsCount = 0;
          let minerFarmsCount = 0;
          let bothTypesFarmsCount = 0;

          for (const [farmId, types] of farmPurchasesByFarmId) {
            const hasLaunchpad = types.has("launchpad");
            const hasMiningCenter = types.has("mining-center");

            if (hasLaunchpad && hasMiningCenter) {
              bothTypesFarmsCount++;
            } else if (hasLaunchpad) {
              delegatorFarmsCount++;
            } else if (hasMiningCenter) {
              minerFarmsCount++;
            }
          }

          const walletRewards = walletRewardsMap.get(walletLower) || [];
          const accurateStartMs = nowMs();
          const accurateAPY = await calculateAccurateWalletAPY(
            walletLower,
            actualStartWeek,
            actualEndWeek,
            glwSpotPrice,
            walletRewards,
            farmPurchases
          );
          recordTiming(
            "rewardsBreakdown.compute.accurateApy",
            accurateStartMs,
            {
              farms: farmPurchases.length,
              rewardRows: walletRewards.length,
            }
          );

          const delegatorApyPercent = accurateAPY.delegatorAPY.toFixed(4);
          const minerApyPercentFormatted = accurateAPY.minerAPY.toFixed(4);

          // Create a lookup for isVaultOwnership from farmPurchaseMap
          const vaultOwnershipLookup = new Map<string, boolean>();
          for (const [key, purchase] of farmPurchaseMap) {
            if (purchase.isVaultOwnership) {
              vaultOwnershipLookup.set(purchase.farmId, true);
            }
          }

          const farmDetails = accurateAPY.farmBreakdowns.map((farm) => ({
            farmId: farm.farmId,
            type: farm.type,
            amountInvested: farm.amountInvested.toString(),
            firstWeekWithRewards: farm.firstWeekWithRewards,
            totalWeeksEarned: farm.totalWeeksEarned,
            totalEarnedSoFar: farm.totalEarnedSoFar.toString(),
            totalInflationRewards: farm.totalInflationRewards.toString(),
            totalProtocolDepositRewards:
              farm.totalProtocolDepositRewards.toString(),
            lastWeekRewards: farm.lastWeekRewards.toString(),
            apy: farm.apy.toFixed(4),
            weeklyBreakdown: farm.weeklyBreakdown.map((week) => ({
              weekNumber: week.weekNumber,
              inflationRewards: week.inflationRewards.toString(),
              protocolDepositRewards: week.protocolDepositRewards.toString(),
              totalRewards: week.totalRewards.toString(),
            })),
            ...(vaultOwnershipLookup.get(farm.farmId)
              ? { isVaultOwnership: true }
              : {}),
          }));

          let delegatorLastWeek = BigInt(0);
          let delegatorAllWeeks = BigInt(0);
          let minerLastWeek = BigInt(0);
          let minerAllWeeks = BigInt(0);
          const weeksWithRewardsSet = new Set<number>();

          for (const farm of accurateAPY.farmBreakdowns) {
            if (farm.type === "launchpad") {
              delegatorLastWeek += farm.lastWeekRewards;
              delegatorAllWeeks += farm.totalEarnedSoFar;
            } else {
              minerLastWeek += farm.lastWeekRewards;
              minerAllWeeks += farm.totalEarnedSoFar;
            }

            for (const week of farm.weeklyBreakdown) {
              weeksWithRewardsSet.add(week.weekNumber);
            }
          }

          const farmsWithSplits = new Set(
            rewardSplits
              .map((r) => r.farmId)
              .filter((id): id is string => id !== null)
          );

          const purchasedFarmIds = new Set(farms);
          const otherFarmIds = Array.from(farmsWithSplits).filter(
            (farmId) => !purchasedFarmIds.has(farmId)
          );

          let otherFarmsRewards: any[] = [];
          if (otherFarmIds.length > 0) {
            try {
              const otherT0 = nowMs();
              const otherFarmsMap = new Map<
                string,
                {
                  farmId: string;
                  farmName: string | null;
                  builtEpoch: number | null;
                  asset: string | null;
                  totalInflationRewards: bigint;
                  totalProtocolDepositRewards: bigint;
                  totalRewards: bigint;
                  lastWeekRewards: bigint;
                  lastWeekNumber: number | null;
                  weeklyBreakdown: Array<{
                    weekNumber: number;
                    inflationRewards: bigint;
                    protocolDepositRewards: bigint;
                    totalRewards: bigint;
                  }>;
                }
              >();

              for (const reward of walletRewards as any[]) {
                if (!otherFarmIds.includes(reward.farmId)) {
                  continue;
                }

                if (!otherFarmsMap.has(reward.farmId)) {
                  otherFarmsMap.set(reward.farmId, {
                    farmId: reward.farmId,
                    farmName: reward.farmName || null,
                    builtEpoch: reward.builtEpoch || null,
                    asset: reward.asset || null,
                    totalInflationRewards: BigInt(0),
                    totalProtocolDepositRewards: BigInt(0),
                    totalRewards: BigInt(0),
                    lastWeekRewards: BigInt(0),
                    lastWeekNumber: null,
                    weeklyBreakdown: [],
                  });
                }

                const farm = otherFarmsMap.get(reward.farmId)!;

                // IMPORTANT: Avoid `BigInt(bigint)` from `||` operator precedence.
                // If `walletTotal*` is missing, we compute totals from components directly.
                const inflationReward =
                  reward.walletTotalGlowInflationReward != null
                    ? BigInt(reward.walletTotalGlowInflationReward || "0")
                    : BigInt(reward.walletInflationFromLaunchpad || "0") +
                      BigInt(reward.walletInflationFromMiningCenter || "0");
                const depositReward =
                  reward.walletTotalProtocolDepositReward != null
                    ? BigInt(reward.walletTotalProtocolDepositReward || "0")
                    : BigInt(reward.walletProtocolDepositFromLaunchpad || "0") +
                      BigInt(
                        reward.walletProtocolDepositFromMiningCenter || "0"
                      );
                const totalReward = inflationReward + depositReward;

                farm.totalInflationRewards += inflationReward;
                farm.totalProtocolDepositRewards += depositReward;
                farm.totalRewards += totalReward;

                if (totalReward > BigInt(0)) {
                  farm.weeklyBreakdown.push({
                    weekNumber: reward.weekNumber,
                    inflationRewards: inflationReward,
                    protocolDepositRewards: depositReward,
                    totalRewards: totalReward,
                  });
                }

                if (
                  farm.lastWeekNumber === null ||
                  reward.weekNumber > farm.lastWeekNumber
                ) {
                  farm.lastWeekNumber = reward.weekNumber;
                  farm.lastWeekRewards = totalReward;
                }
              }

              const currentWeek = actualEndWeek;

              otherFarmsRewards = Array.from(otherFarmsMap.values())
                .filter((f) => f.totalRewards > BigInt(0))
                .map((f) => {
                  let weeksLeft: number | null = null;

                  if (f.builtEpoch !== null) {
                    if (f.builtEpoch < 97) {
                      const weeksLivedInV1 = 97 - f.builtEpoch;
                      const v2EquivalentWeeksLived = weeksLivedInV1 / 2.08;
                      const remainingV2Weeks = 100 - v2EquivalentWeeksLived;
                      const endEpoch = 97 + remainingV2Weeks;
                      weeksLeft = Math.max(
                        0,
                        Math.floor(endEpoch - currentWeek)
                      );
                    } else {
                      weeksLeft = Math.max(0, f.builtEpoch + 100 - currentWeek);
                    }
                  }

                  return {
                    farmId: f.farmId,
                    farmName: f.farmName,
                    builtEpoch: f.builtEpoch,
                    weeksLeft,
                    asset: f.asset,
                    totalInflationRewards: f.totalInflationRewards.toString(),
                    totalProtocolDepositRewards:
                      f.totalProtocolDepositRewards.toString(),
                    totalRewards: f.totalRewards.toString(),
                    lastWeekRewards: f.lastWeekRewards.toString(),
                    weeklyBreakdown: f.weeklyBreakdown.map((week) => ({
                      weekNumber: week.weekNumber,
                      inflationRewards: week.inflationRewards.toString(),
                      protocolDepositRewards:
                        week.protocolDepositRewards.toString(),
                      totalRewards: week.totalRewards.toString(),
                    })),
                  };
                })
                .sort((a, b) =>
                  Number(BigInt(b.totalRewards) - BigInt(a.totalRewards))
                );
              recordTiming("rewardsBreakdown.compute.otherFarms", otherT0, {
                otherFarms: otherFarmsRewards.length,
              });
            } catch (error) {
              console.error("Failed to fetch other farms rewards:", error);
            }
          }

          const recentPurchasesWithoutRewards: Array<{
            farmId: string;
            types: ("launchpad" | "mining-center")[];
          }> = [];

          if (
            totalGlwDelegatedAfter > BigInt(0) ||
            totalUsdcSpentAfter > BigInt(0)
          ) {
            for (const [farmId, typesSet] of recentFarmTypesMap) {
              recentPurchasesWithoutRewards.push({
                farmId,
                types: Array.from(typesSet),
              });
            }
          }

          recordTiming("rewardsBreakdown.wallet.total", walletStartMs, {
            farms: farms.length,
            otherFarms: otherFarmIds.length,
          });
          if (shouldLogTimings) {
            const msTotal = nowMs() - requestStartMs;
            timingEvents.push({ label: "rewardsBreakdown.total", ms: msTotal });
            console.log("[fractionsRouter] /rewards-breakdown timings", {
              requestId,
              wallet: walletLower,
              weekRange: { startWeek: actualStartWeek, endWeek: actualEndWeek },
              timings: timingEvents
                .slice()
                .sort((a, b) => b.ms - a.ms)
                .map((t) => ({
                  label: t.label,
                  ms: Math.round(t.ms * 10) / 10,
                  ...(t.meta ? { meta: t.meta } : {}),
                })),
              msTotal: Math.round(msTotal * 10) / 10,
            });
          }

          return {
            type: "wallet",
            walletAddress: walletLower,
            farms,
            farmStatistics: {
              totalFarms: farms.length,
              delegatorOnlyFarms: delegatorFarmsCount,
              minerOnlyFarms: minerFarmsCount,
              bothTypesFarms: bothTypesFarmsCount,
            },
            totals: {
              totalGlwDelegated: totalGlwDelegated.toString(),
              totalUsdcSpentByMiners: totalUsdcSpent.toString(),
            },
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
              weeksWithRewards: weeksWithRewardsSet.size,
            },
            delegatedAfterWeekRange: {
              totalGlwDelegatedAfter: totalGlwDelegatedAfter.toString(),
              totalUsdcSpentAfter: totalUsdcSpentAfter.toString(),
            },
            recentPurchasesWithoutRewards,
            rewards: {
              delegator: {
                lastWeek: delegatorLastWeek.toString(),
                allWeeks: delegatorAllWeeks.toString(),
              },
              miner: {
                lastWeek: minerLastWeek.toString(),
                allWeeks: minerAllWeeks.toString(),
              },
            },
            apy: {
              delegatorApyPercent,
              minerApyPercent: minerApyPercentFormatted,
            },
            farmDetails,
            otherFarmsWithRewards: {
              count: otherFarmsRewards.length,
              farms: otherFarmsRewards,
            },
          };
        }

        if (farmId) {
          const farmStartMs = nowMs();
          const [purchaseInfo, farmPurchasesAfterWeek] = await Promise.all([
            getWalletPurchaseTypesByFarmUpToWeek({
              endWeek: actualEndWeek,
              farmId,
            }),
            getFarmPurchasesAfterWeek(farmId, actualEndWeek),
          ]);

          const wallets = Array.from(purchaseInfo.walletToFarmTypes.keys());
          if (wallets.length === 0) {
            set.status = 404;
            return "Farm not found or has no rewards";
          }

          const rewardsByWallet = await fetchWalletRewardsHistoryMany({
            wallets,
            startWeek: actualStartWeek,
            endWeek: actualEndWeek,
          });

          let delegatorLastWeek = BigInt(0);
          let delegatorAllWeeks = BigInt(0);
          let minerLastWeek = BigInt(0);
          let minerAllWeeks = BigInt(0);

          const fractionTypesSet = new Set<"launchpad" | "mining-center">();
          for (const wallet of wallets) {
            const types = purchaseInfo.walletToFarmTypes
              .get(wallet)
              ?.get(farmId);
            if (types) {
              for (const t of types) {
                fractionTypesSet.add(t);
              }
            }

            const farmRewards = rewardsByWallet.get(wallet) || [];
            for (const reward of farmRewards) {
              if (reward.farmId !== farmId) continue;

              const launchpadInflation = BigInt(
                reward.walletInflationFromLaunchpad || "0"
              );
              const launchpadDeposit = BigInt(
                reward.walletProtocolDepositFromLaunchpad || "0"
              );
              const miningCenterInflation = BigInt(
                reward.walletInflationFromMiningCenter || "0"
              );
              const miningCenterDeposit = BigInt(
                reward.walletProtocolDepositFromMiningCenter || "0"
              );

              const delegatorReward = launchpadInflation + launchpadDeposit;
              const minerReward = miningCenterInflation + miningCenterDeposit;

              delegatorAllWeeks += delegatorReward;
              minerAllWeeks += minerReward;

              if (reward.weekNumber === actualEndWeek) {
                delegatorLastWeek += delegatorReward;
                minerLastWeek += minerReward;
              }
            }
          }

          return {
            type: "farm",
            farmId,
            appId: purchaseInfo.appIdByFarmId.get(farmId) || "",
            fractionTypes: Array.from(fractionTypesSet),
            wallets,
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
            },
            delegatedAfterWeekRange: {
              totalGlwDelegatedAfter:
                farmPurchasesAfterWeek.totalGlwDelegatedAfter.toString(),
              totalUsdcSpentAfter:
                farmPurchasesAfterWeek.totalUsdcSpentAfter.toString(),
            },
            rewards: {
              delegator: {
                lastWeek: delegatorLastWeek.toString(),
                allWeeks: delegatorAllWeeks.toString(),
              },
              miner: {
                lastWeek: minerLastWeek.toString(),
                allWeeks: minerAllWeeks.toString(),
              },
            },
          };
        }

        set.status = 400;
        return "Invalid request";
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        walletAddress: t.Optional(
          t.String({
            pattern: "^0x[a-fA-F0-9]{40}$",
            description: "Wallet address to get rewards for",
          })
        ),
        farmId: t.Optional(
          t.String({
            description: "Farm ID to get rewards for",
          })
        ),
        startWeek: t.Optional(
          t.String({
            description: "Start week number (defaults to week 97)",
          })
        ),
        endWeek: t.Optional(
          t.String({
            description: "End week number (defaults to last completed week)",
          })
        ),
        debugTimings: t.Optional(
          t.String({
            description: "Emit timing logs (true|1)",
          })
        ),
      }),
      detail: {
        summary: "Get rewards breakdown by wallet or farm",
        description:
          "Returns detailed rewards breakdown for a specific wallet or farm, showing delegator and miner rewards for the last week and across all weeks. If walletAddress is provided, returns aggregated rewards across all farms for that wallet. If farmId is provided, returns aggregated rewards across all wallets for that farm.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/wallets/activity",
    async ({ query: { type, sortBy, limit }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        const weekRange = getWeekRange();
        const { startWeek, endWeek } = weekRange;

        const purchaseInfo = await getWalletPurchaseTypesByFarmUpToWeek({
          endWeek,
        });
        const walletsToProcess = Array.from(
          purchaseInfo.walletToFarmTypes.keys()
        );

        const parsedLimit = limit ? parseInt(limit) : undefined;
        if (
          parsedLimit !== undefined &&
          (isNaN(parsedLimit) || parsedLimit < 1)
        ) {
          set.status = 400;
          return "Limit must be a positive number";
        }

        const allBatchRewards = new Map<string, any[]>();
        const allPurchasesUpToWeek = await getBatchPurchasesUpToWeek(
          walletsToProcess,
          endWeek
        );
        const allPurchasesAfterWeek = await getBatchPurchasesAfterWeek(
          walletsToProcess,
          endWeek
        );
        const rewardsByWallet = await fetchWalletRewardsHistoryMany({
          wallets: walletsToProcess,
          startWeek,
          endWeek,
        });
        for (const [wallet, rewards] of rewardsByWallet) {
          allBatchRewards.set(wallet, rewards);
        }

        const walletActivities: Array<{
          walletAddress: string;
          glwDelegated: string;
          usdcSpentOnMiners: string;
          glwDelegatedAfterRange: string;
          usdcSpentAfterRange: string;
          delegatorRewardsEarned: string;
          minerRewardsEarned: string;
          totalRewardsEarned: string;
        }> = [];

        for (const wallet of walletsToProcess) {
          const walletFarms = purchaseInfo.walletToFarmTypes.get(wallet);
          const farmRewards = allBatchRewards.get(wallet) || [];

          if (!walletFarms || walletFarms.size === 0) {
            continue;
          }

          const purchasesUpToWeek = allPurchasesUpToWeek.get(wallet) || {
            totalGlwDelegated: BigInt(0),
            totalUsdcSpent: BigInt(0),
          };
          const purchasesAfterWeek = allPurchasesAfterWeek.get(wallet) || {
            totalGlwDelegatedAfter: BigInt(0),
            totalUsdcSpentAfter: BigInt(0),
          };

          let delegatorRewards = BigInt(0);
          let minerRewards = BigInt(0);

          const farmIds = new Set(walletFarms.keys());

          for (const reward of farmRewards) {
            if (!farmIds.has(reward.farmId)) {
              continue;
            }

            const launchpadInflation = BigInt(
              reward.walletInflationFromLaunchpad || "0"
            );
            const launchpadDeposit = BigInt(
              reward.walletProtocolDepositFromLaunchpad || "0"
            );
            const miningCenterInflation = BigInt(
              reward.walletInflationFromMiningCenter || "0"
            );

            delegatorRewards += launchpadInflation + launchpadDeposit;
            minerRewards += miningCenterInflation;
          }

          const totalRewards = delegatorRewards + minerRewards;

          if (totalRewards === BigInt(0)) {
            continue;
          }

          const hasDelegatorActivity = delegatorRewards > BigInt(0);
          const hasMinerActivity = minerRewards > BigInt(0);

          if (type === "delegator" && !hasDelegatorActivity) continue;
          if (type === "miner" && !hasMinerActivity) continue;

          walletActivities.push({
            walletAddress: wallet,
            glwDelegated: purchasesUpToWeek.totalGlwDelegated.toString(),
            usdcSpentOnMiners: purchasesUpToWeek.totalUsdcSpent.toString(),
            glwDelegatedAfterRange:
              purchasesAfterWeek.totalGlwDelegatedAfter.toString(),
            usdcSpentAfterRange:
              purchasesAfterWeek.totalUsdcSpentAfter.toString(),
            delegatorRewardsEarned: delegatorRewards.toString(),
            minerRewardsEarned: minerRewards.toString(),
            totalRewardsEarned: totalRewards.toString(),
          });
        }

        const sortField = sortBy || "totalRewardsEarned";
        walletActivities.sort((a, b) => {
          const aValue = BigInt(a[sortField as keyof typeof a] || "0");
          const bValue = BigInt(b[sortField as keyof typeof b] || "0");
          return Number(bValue - aValue);
        });

        const limitedResults = parsedLimit
          ? walletActivities.slice(0, parsedLimit)
          : walletActivities;

        return {
          weekRange: {
            startWeek,
            endWeek,
          },
          summary: {
            totalWallets: walletActivities.length,
            returnedWallets: limitedResults.length,
          },
          wallets: limitedResults,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        type: t.Optional(
          t.Union([
            t.Literal("delegator"),
            t.Literal("miner"),
            t.Literal("both"),
          ])
        ),
        sortBy: t.Optional(
          t.Union([
            t.Literal("glwDelegated"),
            t.Literal("usdcSpentOnMiners"),
            t.Literal("delegatorRewardsEarned"),
            t.Literal("minerRewardsEarned"),
            t.Literal("totalRewardsEarned"),
          ])
        ),
        limit: t.Optional(
          t.String({
            description: "Limit number of results returned",
          })
        ),
      }),
      detail: {
        summary: "Get all wallet activity with delegation and rewards",
        description:
          "Returns a list of all wallets that have delegated GLW or purchased mining-center fractions, showing their total amounts delegated/spent and total rewards earned. Results are sorted by total rewards earned (descending) by default. Optionally filter by type (delegator/miner/both), change sort field, and limit results. Uses batch API calls for efficiency.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/farms/activity",
    async ({ query: { type, sortBy, limit }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        const weekRange = getWeekRange();
        const { startWeek, endWeek } = weekRange;

        const purchaseInfo = await getWalletPurchaseTypesByFarmUpToWeek({
          endWeek,
        });
        const walletsToProcess = Array.from(
          purchaseInfo.walletToFarmTypes.keys()
        );

        const parsedLimit = limit ? parseInt(limit) : undefined;
        if (
          parsedLimit !== undefined &&
          (isNaN(parsedLimit) || parsedLimit < 1)
        ) {
          set.status = 400;
          return "Limit must be a positive number";
        }

        const allBatchRewards = new Map<string, any[]>();
        const rewardsByWallet = await fetchWalletRewardsHistoryMany({
          wallets: walletsToProcess,
          startWeek,
          endWeek,
        });
        for (const [wallet, rewards] of rewardsByWallet) {
          allBatchRewards.set(wallet, rewards);
        }

        const farmActivities = new Map<
          string,
          {
            farmId: string;
            farmName: string | null;
            delegatorRewardsDistributed: bigint;
            minerRewardsDistributed: bigint;
            totalRewardsDistributed: bigint;
            uniqueDelegators: Set<string>;
            uniqueMiners: Set<string>;
          }
        >();

        for (const wallet of walletsToProcess) {
          const walletFarms = purchaseInfo.walletToFarmTypes.get(wallet);
          const farmRewards = allBatchRewards.get(wallet) || [];

          if (!walletFarms || walletFarms.size === 0) {
            continue;
          }

          for (const reward of farmRewards) {
            const farmTypes = walletFarms.get(reward.farmId);
            if (!farmTypes) {
              continue;
            }

            if (!farmActivities.has(reward.farmId)) {
              farmActivities.set(reward.farmId, {
                farmId: reward.farmId,
                farmName: reward.farmName || null,
                delegatorRewardsDistributed: BigInt(0),
                minerRewardsDistributed: BigInt(0),
                totalRewardsDistributed: BigInt(0),
                uniqueDelegators: new Set(),
                uniqueMiners: new Set(),
              });
            }

            const farm = farmActivities.get(reward.farmId)!;

            const launchpadInflation = BigInt(
              reward.walletInflationFromLaunchpad || "0"
            );
            const launchpadDeposit = BigInt(
              reward.walletProtocolDepositFromLaunchpad || "0"
            );
            const miningCenterInflation = BigInt(
              reward.walletInflationFromMiningCenter || "0"
            );

            const delegatorReward = launchpadInflation + launchpadDeposit;
            const minerReward = miningCenterInflation;

            farm.delegatorRewardsDistributed += delegatorReward;
            farm.minerRewardsDistributed += minerReward;
            farm.totalRewardsDistributed += delegatorReward + minerReward;

            if (delegatorReward > BigInt(0) && farmTypes.has("launchpad")) {
              farm.uniqueDelegators.add(wallet);
            }
            if (minerReward > BigInt(0) && farmTypes.has("mining-center")) {
              farm.uniqueMiners.add(wallet);
            }
          }
        }

        const farmList = Array.from(farmActivities.values())
          .filter((farm) => farm.totalRewardsDistributed > BigInt(0))
          .filter((farm) => {
            const hasDelegatorActivity =
              farm.delegatorRewardsDistributed > BigInt(0);
            const hasMinerActivity = farm.minerRewardsDistributed > BigInt(0);

            if (type === "delegator" && !hasDelegatorActivity) return false;
            if (type === "miner" && !hasMinerActivity) return false;
            return true;
          })
          .map((farm) => ({
            farmId: farm.farmId,
            farmName: farm.farmName,
            delegatorRewardsDistributed:
              farm.delegatorRewardsDistributed.toString(),
            minerRewardsDistributed: farm.minerRewardsDistributed.toString(),
            totalRewardsDistributed: farm.totalRewardsDistributed.toString(),
            uniqueDelegators: farm.uniqueDelegators.size,
            uniqueMiners: farm.uniqueMiners.size,
            totalUniqueParticipants:
              farm.uniqueDelegators.size + farm.uniqueMiners.size,
          }));

        const sortField = sortBy || "totalRewardsDistributed";
        farmList.sort((a, b) => {
          const aValue = BigInt(a[sortField as keyof typeof a] || "0");
          const bValue = BigInt(b[sortField as keyof typeof b] || "0");
          return Number(bValue - aValue);
        });

        const limitedResults = parsedLimit
          ? farmList.slice(0, parsedLimit)
          : farmList;

        return {
          weekRange: {
            startWeek,
            endWeek,
          },
          summary: {
            totalFarms: farmList.length,
            returnedFarms: limitedResults.length,
          },
          farms: limitedResults,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        type: t.Optional(
          t.Union([
            t.Literal("delegator"),
            t.Literal("miner"),
            t.Literal("both"),
          ])
        ),
        sortBy: t.Optional(
          t.Union([
            t.Literal("delegatorRewardsDistributed"),
            t.Literal("minerRewardsDistributed"),
            t.Literal("totalRewardsDistributed"),
          ])
        ),
        limit: t.Optional(
          t.String({
            description: "Limit number of results returned",
          })
        ),
      }),
      detail: {
        summary: "Get all farm activity with rewards distributed",
        description:
          "Returns a list of all farms that have distributed rewards to delegators or miners, showing total rewards distributed and participant counts. Results are sorted by total rewards distributed (descending) by default. Optionally filter by type (delegator/miner/both), change sort field, and limit results. Uses batch API calls for efficiency.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/farms-per-piece-stats",
    async ({ query: { farmId, startWeek, endWeek }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

        const weekRange = getWeekRange();
        const actualStartWeek = startWeek
          ? parseInt(startWeek)
          : weekRange.startWeek;
        const actualEndWeek = endWeek ? parseInt(endWeek) : weekRange.endWeek;

        if (isNaN(actualStartWeek) || isNaN(actualEndWeek)) {
          set.status = 400;
          return "Invalid week range";
        }

        const glwSpotPricePromise = getCachedGlwSpotPriceNumber();
        const farmStatsPromise = getFilledStepStatsByFarm(actualEndWeek);
        const purchaseInfoPromise = getWalletPurchaseTypesByFarmUpToWeek({
          endWeek: actualEndWeek,
          farmId,
        });

        const [glwSpotPrice, farmStatsMap, purchaseInfo] = await Promise.all([
          glwSpotPricePromise,
          farmStatsPromise,
          purchaseInfoPromise,
        ]);

        const walletsArray = Array.from(purchaseInfo.walletToFarmTypes.keys());
        const allFarmIds = new Set<string>();
        const appIds = new Set<string>();

        for (const farmIdKey of farmStatsMap.keys()) {
          allFarmIds.add(farmIdKey);
        }
        for (const farmIdKey of purchaseInfo.farmParticipants.keys()) {
          allFarmIds.add(farmIdKey);
        }

        const farmIdsArray = farmId
          ? allFarmIds.has(farmId)
            ? [farmId]
            : []
          : Array.from(allFarmIds);

        if (farmIdsArray.length === 0) {
          return {
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
            },
            farms: [],
          };
        }

        for (const farmIdKey of farmIdsArray) {
          const stats = farmStatsMap.get(farmIdKey);
          if (stats) {
            for (const [_, stat] of stats) {
              appIds.add(stat.appId);
            }
          }
          const appId = purchaseInfo.appIdByFarmId.get(farmIdKey);
          if (appId) appIds.add(appId);
        }

        const walletsForFarms = new Set<string>();
        if (farmId) {
          for (const wallet of walletsArray) {
            const farms = purchaseInfo.walletToFarmTypes.get(wallet);
            if (farms?.has(farmId)) {
              walletsForFarms.add(wallet);
            }
          }
        } else {
          for (const wallet of walletsArray) {
            walletsForFarms.add(wallet);
          }
        }

        if (walletsForFarms.size === 0 && appIds.size === 0) {
          return {
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
            },
            farms: [],
          };
        }

        const farmNamesPromise = getFarmNamesByApplicationIds(
          Array.from(appIds)
        );
        const walletRewardsPromise = (async () => {
          const walletBatchRewards = new Map<string, any[]>();
          const wallets = Array.from(walletsForFarms);
          const batchSize = 500;
          const concurrentBatches = 5;

          for (
            let i = 0;
            i < wallets.length;
            i += batchSize * concurrentBatches
          ) {
            const batchPromises: Array<Promise<Map<string, any[]>>> = [];

            for (
              let j = 0;
              j < concurrentBatches && i + j * batchSize < wallets.length;
              j++
            ) {
              const batch = wallets.slice(
                i + j * batchSize,
                i + (j + 1) * batchSize
              );

              batchPromises.push(
                fetchWalletRewardsHistoryBatch({
                  wallets: batch,
                  startWeek: actualStartWeek,
                  endWeek: actualEndWeek,
                })
                  .then((m) => m as unknown as Map<string, any[]>)
                  .catch((error) => {
                    console.error(
                      "Failed to fetch wallet rewards batch:",
                      error
                    );
                    return new Map<string, any[]>();
                  })
              );
            }

            const results = await Promise.all(batchPromises);
            for (const m of results) {
              for (const [wallet, rewards] of m) {
                walletBatchRewards.set(wallet.toLowerCase(), rewards);
              }
            }
          }

          return walletBatchRewards;
        })();

        const [farmNamesMap, walletBatchRewards] = await Promise.all([
          farmNamesPromise,
          walletRewardsPromise,
        ]);

        type WeeklyAgg = {
          inflation: bigint;
          protocolDeposit: bigint;
          asset: string | null;
        };
        const ensureWeeklyAgg = (
          map: Map<number, WeeklyAgg>,
          week: number,
          asset: string | null
        ) => {
          const existing = map.get(week);
          if (existing) {
            if (existing.asset === null && asset !== null) {
              existing.asset = asset;
            }
            return existing;
          }
          const created: WeeklyAgg = {
            inflation: BigInt(0),
            protocolDeposit: BigInt(0),
            asset,
          };
          map.set(week, created);
          return created;
        };

        const farmWeeklyAgg = new Map<
          string,
          { delegator: Map<number, WeeklyAgg>; miner: Map<number, WeeklyAgg> }
        >();

        for (const [wallet, farms] of purchaseInfo.walletToFarmTypes) {
          if (!walletsForFarms.has(wallet)) continue;

          const walletRewards = walletBatchRewards.get(wallet) || [];
          if (walletRewards.length === 0) continue;

          for (const reward of walletRewards) {
            const rewardFarmId = reward.farmId;
            const weekNum = Number(reward.weekNumber);
            if (!rewardFarmId) continue;
            if (weekNum < actualStartWeek || weekNum > actualEndWeek) continue;

            const farmTypes = farms.get(rewardFarmId);
            if (!farmTypes) continue;
            const asset = reward.asset || null;

            if (!farmWeeklyAgg.has(rewardFarmId)) {
              farmWeeklyAgg.set(rewardFarmId, {
                delegator: new Map(),
                miner: new Map(),
              });
            }
            const agg = farmWeeklyAgg.get(rewardFarmId)!;

            if (farmTypes.has("launchpad")) {
              const inflation = BigInt(
                reward.walletInflationFromLaunchpad || "0"
              );
              const protocolDeposit = BigInt(
                reward.walletProtocolDepositFromLaunchpad || "0"
              );
              if (inflation > BigInt(0) || protocolDeposit > BigInt(0)) {
                const bucket = ensureWeeklyAgg(agg.delegator, weekNum, asset);
                bucket.inflation += inflation;
                bucket.protocolDeposit += protocolDeposit;
              }
            }

            if (farmTypes.has("mining-center")) {
              const inflation = BigInt(
                reward.walletInflationFromMiningCenter || "0"
              );
              const protocolDeposit = BigInt(
                reward.walletProtocolDepositFromMiningCenter || "0"
              );
              if (inflation > BigInt(0) || protocolDeposit > BigInt(0)) {
                const bucket = ensureWeeklyAgg(agg.miner, weekNum, asset);
                bucket.inflation += inflation;
                bucket.protocolDeposit += protocolDeposit;
              }
            }
          }
        }

        const farms = farmIdsArray
          .map((farmIdKey) => {
            const stepStats = farmStatsMap.get(farmIdKey);
            const participants = purchaseInfo.farmParticipants.get(farmIdKey);
            const weeklyAgg = farmWeeklyAgg.get(farmIdKey);

            if (!stepStats && !participants && !weeklyAgg) {
              return null;
            }

            const launchpadStats = stepStats?.get("launchpad");
            const miningCenterStats = stepStats?.get("mining-center");

            const fractionTypes: ("launchpad" | "mining-center")[] = [];
            if (launchpadStats) fractionTypes.push("launchpad");
            if (miningCenterStats) fractionTypes.push("mining-center");
            if (participants?.uniqueDelegators) {
              if (!fractionTypes.includes("launchpad"))
                fractionTypes.push("launchpad");
            }
            if (participants?.uniqueMiners) {
              if (!fractionTypes.includes("mining-center"))
                fractionTypes.push("mining-center");
            }

            const appId =
              launchpadStats?.appId ||
              miningCenterStats?.appId ||
              purchaseInfo.appIdByFarmId.get(farmIdKey) ||
              "";

            const farmName = farmNamesMap.get(appId) || null;

            const delegatorWeeklyMap = weeklyAgg?.delegator || new Map();
            const minerWeeklyMap = weeklyAgg?.miner || new Map();

            const delegatorWeeklyBreakdown = Array.from(
              delegatorWeeklyMap.entries()
            )
              .sort((a, b) => b[0] - a[0])
              .map(([weekNumber, data]) => ({
                weekNumber,
                inflationRewards: data.inflation.toString(),
                protocolDepositRewards: data.protocolDeposit.toString(),
                protocolDepositAsset: data.asset,
                totalRewards: (
                  data.inflation + data.protocolDeposit
                ).toString(),
              }));

            const minerWeeklyBreakdown = Array.from(minerWeeklyMap.entries())
              .sort((a, b) => b[0] - a[0])
              .map(([weekNumber, data]) => ({
                weekNumber,
                inflationRewards: data.inflation.toString(),
                protocolDepositRewards: data.protocolDeposit.toString(),
                protocolDepositAsset: data.asset,
                totalRewards: (
                  data.inflation + data.protocolDeposit
                ).toString(),
              }));

            const delegatorWeeksEarned = delegatorWeeklyBreakdown.length;
            const minerWeeksEarned = minerWeeklyBreakdown.length;

            let delegatorInflationAllWeeks = BigInt(0);
            let delegatorProtocolDepositAllWeeks = BigInt(0);
            let delegatorInflationLastWeek = BigInt(0);
            let delegatorProtocolDepositLastWeek = BigInt(0);

            for (const week of delegatorWeeklyBreakdown) {
              const inflation = BigInt(week.inflationRewards);
              const deposit = BigInt(week.protocolDepositRewards);
              delegatorInflationAllWeeks += inflation;
              delegatorProtocolDepositAllWeeks += deposit;
              if (week.weekNumber === actualEndWeek) {
                delegatorInflationLastWeek = inflation;
                delegatorProtocolDepositLastWeek = deposit;
              }
            }

            let minerInflationAllWeeks = BigInt(0);
            let minerProtocolDepositAllWeeks = BigInt(0);
            let minerInflationLastWeek = BigInt(0);
            let minerProtocolDepositLastWeek = BigInt(0);

            for (const week of minerWeeklyBreakdown) {
              const inflation = BigInt(week.inflationRewards);
              const deposit = BigInt(week.protocolDepositRewards);
              minerInflationAllWeeks += inflation;
              minerProtocolDepositAllWeeks += deposit;
              if (week.weekNumber === actualEndWeek) {
                minerInflationLastWeek = inflation;
                minerProtocolDepositLastWeek = deposit;
              }
            }

            const delegatorStepsSold = launchpadStats?.totalStepsSold || 0;
            const delegatorWeightedPieceSizeGlw =
              launchpadStats?.weightedAverageStepPrice || "0";
            const delegatorWeeksLeft = Math.max(0, 100 - delegatorWeeksEarned);
            const minerWeeksLeft = Math.max(0, 99 - minerWeeksEarned);

            const delegatorStepsSoldBigInt = BigInt(delegatorStepsSold);
            const delegatorInflationPerPieceLastWeek =
              delegatorStepsSold > 0
                ? (
                    delegatorInflationLastWeek / delegatorStepsSoldBigInt
                  ).toString()
                : "0";
            const delegatorInflationPerPieceAllWeeks =
              delegatorStepsSold > 0
                ? (
                    delegatorInflationAllWeeks / delegatorStepsSoldBigInt
                  ).toString()
                : "0";
            const delegatorProtocolDepositPerPieceLastWeek =
              delegatorStepsSold > 0
                ? (
                    delegatorProtocolDepositLastWeek / delegatorStepsSoldBigInt
                  ).toString()
                : "0";
            const delegatorProtocolDepositPerPieceAllWeeks =
              delegatorStepsSold > 0
                ? (
                    delegatorProtocolDepositAllWeeks / delegatorStepsSoldBigInt
                  ).toString()
                : "0";
            const delegatorTotalPerPieceLastWeek =
              delegatorStepsSold > 0
                ? (
                    (delegatorInflationLastWeek +
                      delegatorProtocolDepositLastWeek) /
                    delegatorStepsSoldBigInt
                  ).toString()
                : "0";
            const delegatorTotalPerPieceAllWeeks =
              delegatorStepsSold > 0
                ? (
                    (delegatorInflationAllWeeks +
                      delegatorProtocolDepositAllWeeks) /
                    delegatorStepsSoldBigInt
                  ).toString()
                : "0";

            const delegatorWeightedPieceSize = BigInt(
              delegatorWeightedPieceSizeGlw
            );
            const delegatorTotalInvestment =
              delegatorWeightedPieceSize * delegatorStepsSoldBigInt;
            const delegatorRoiLastWeek =
              delegatorTotalInvestment > BigInt(0)
                ? (
                    (Number(
                      delegatorInflationLastWeek +
                        delegatorProtocolDepositLastWeek
                    ) /
                      Number(delegatorTotalInvestment)) *
                    100
                  ).toFixed(4)
                : "0.0000";
            const delegatorRoiAllWeeks =
              delegatorTotalInvestment > BigInt(0)
                ? (
                    (Number(
                      delegatorInflationAllWeeks +
                        delegatorProtocolDepositAllWeeks
                    ) /
                      Number(delegatorTotalInvestment)) *
                    100
                  ).toFixed(4)
                : "0.0000";

            const minerStepsSold = miningCenterStats?.totalStepsSold || 0;
            const minerWeightedPiecePriceUsdc =
              miningCenterStats?.weightedAverageStepPrice || "0";
            const minerInflationPerPieceLastWeek =
              minerStepsSold > 0
                ? (minerInflationLastWeek / BigInt(minerStepsSold)).toString()
                : "0";
            const minerInflationPerPieceAllWeeks =
              minerStepsSold > 0
                ? (minerInflationAllWeeks / BigInt(minerStepsSold)).toString()
                : "0";
            const minerProtocolDepositPerPieceLastWeek =
              minerStepsSold > 0
                ? (
                    minerProtocolDepositLastWeek / BigInt(minerStepsSold)
                  ).toString()
                : "0";
            const minerProtocolDepositPerPieceAllWeeks =
              minerStepsSold > 0
                ? (
                    minerProtocolDepositAllWeeks / BigInt(minerStepsSold)
                  ).toString()
                : "0";

            const minerTotalPerPieceLastWeek =
              minerStepsSold > 0
                ? (
                    (minerInflationLastWeek + minerProtocolDepositLastWeek) /
                    BigInt(minerStepsSold)
                  ).toString()
                : "0";
            const minerTotalPerPieceAllWeeks =
              minerStepsSold > 0
                ? (
                    (minerInflationAllWeeks + minerProtocolDepositAllWeeks) /
                    BigInt(minerStepsSold)
                  ).toString()
                : "0";

            const minerWeightedPiecePrice = BigInt(minerWeightedPiecePriceUsdc);
            const minerTotalInvestment =
              minerWeightedPiecePrice * BigInt(minerStepsSold);
            const minerRewardsUsdLastWeek =
              (Number(minerInflationLastWeek + minerProtocolDepositLastWeek) /
                1e18) *
              glwSpotPrice;
            const minerRewardsUsdAllWeeks =
              (Number(minerInflationAllWeeks + minerProtocolDepositAllWeeks) /
                1e18) *
              glwSpotPrice;
            const minerInvestmentUsd = Number(minerTotalInvestment) / 1e6;

            const minerRoiLastWeek =
              minerInvestmentUsd > 0
                ? (
                    (minerRewardsUsdLastWeek / minerInvestmentUsd) *
                    100
                  ).toFixed(4)
                : "0.0000";
            const minerRoiAllWeeks =
              minerInvestmentUsd > 0
                ? (
                    (minerRewardsUsdAllWeeks / minerInvestmentUsd) *
                    100
                  ).toFixed(4)
                : "0.0000";

            const uniqueDelegators = participants?.uniqueDelegators || 0;
            const uniqueMiners = participants?.uniqueMiners || 0;

            return {
              farmId: farmIdKey,
              appId,
              farmName,
              fractionTypes,
              delegator: {
                filledListings: launchpadStats?.filledFractionsCount || 0,
                stepsSold: delegatorStepsSold,
                weightedPieceSizeGlw: delegatorWeightedPieceSizeGlw,
                weeksEarned: delegatorWeeksEarned,
                weeksLeft: delegatorWeeksLeft,
                rewardsPerPiece: {
                  total: {
                    lastWeek: delegatorTotalPerPieceLastWeek,
                    allWeeks: delegatorTotalPerPieceAllWeeks,
                  },
                  inflation: {
                    lastWeek: delegatorInflationPerPieceLastWeek,
                    allWeeks: delegatorInflationPerPieceAllWeeks,
                  },
                  protocolDeposit: {
                    lastWeek: delegatorProtocolDepositPerPieceLastWeek,
                    allWeeks: delegatorProtocolDepositPerPieceAllWeeks,
                  },
                },
                roi: {
                  lastWeek: delegatorRoiLastWeek,
                  allWeeks: delegatorRoiAllWeeks,
                },
                weeklyBreakdown: delegatorWeeklyBreakdown,
              },
              miner: {
                filledListings: miningCenterStats?.filledFractionsCount || 0,
                stepsSold: minerStepsSold,
                weightedPiecePriceUsdc: minerWeightedPiecePriceUsdc,
                weeksEarned: minerWeeksEarned,
                weeksLeft: minerWeeksLeft,
                rewardsPerPiece: {
                  total: {
                    lastWeek: minerTotalPerPieceLastWeek,
                    allWeeks: minerTotalPerPieceAllWeeks,
                  },
                  inflation: {
                    lastWeek: minerInflationPerPieceLastWeek,
                    allWeeks: minerInflationPerPieceAllWeeks,
                  },
                  protocolDeposit: {
                    lastWeek: minerProtocolDepositPerPieceLastWeek,
                    allWeeks: minerProtocolDepositPerPieceAllWeeks,
                  },
                },
                roi: {
                  lastWeek: minerRoiLastWeek,
                  allWeeks: minerRoiAllWeeks,
                },
                weeklyBreakdown: minerWeeklyBreakdown,
              },
              participants: {
                uniqueDelegators,
                uniqueMiners,
              },
            };
          })
          .filter((farm) => farm !== null);

        return {
          weekRange: {
            startWeek: actualStartWeek,
            endWeek: actualEndWeek,
          },
          farms,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        throw new Error("Error Occurred");
      }
    },
    {
      query: t.Object({
        farmId: t.Optional(
          t.String({
            description: "Filter to a specific farm",
          })
        ),
        startWeek: t.Optional(
          t.String({
            description: "Start week number (defaults to week 97)",
          })
        ),
        endWeek: t.Optional(
          t.String({
            description: "End week number (defaults to last completed week)",
          })
        ),
      }),
      detail: {
        summary: "Get per-piece stats for all farms (miners and delegators)",
        description:
          "Returns all farms with fraction sales and rewards, showing per-piece purchase prices and rewards. For delegators, shows weighted piece size in GLW and rewards per piece. For miners, shows weighted piece price in USDC and rewards per piece. Includes participant counts and covers week 97 through the last completed week by default.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/available",
    async ({ query: { type }, set }) => {
      try {
        if (type && type !== "launchpad" && type !== "mining-center") {
          set.status = 400;
          return "type must be either 'launchpad' or 'mining-center'";
        }

        const fractions = await getAvailableFractions({ type });

        const computeSummary = (items: typeof fractions) => {
          const totalCount = items.length;
          let totalStepsRemaining = BigInt(0);
          let totalValueRemaining = BigInt(0);

          const fractionsWithDerived = items.map((fraction) => {
            const remainingSteps =
              BigInt(fraction.totalSteps ?? 0) -
              BigInt(fraction.splitsSold ?? 0);
            const boundedRemainingSteps =
              remainingSteps > BigInt(0) ? remainingSteps : BigInt(0);

            let remainingValue = BigInt(0);
            if (fraction.stepPrice) {
              try {
                remainingValue =
                  BigInt(fraction.stepPrice) * boundedRemainingSteps;
              } catch {
                remainingValue = BigInt(0);
              }
            }

            totalStepsRemaining += boundedRemainingSteps;
            totalValueRemaining += remainingValue;

            return {
              ...fraction,
              remainingSteps: boundedRemainingSteps.toString(),
              remainingValue: remainingValue.toString(),
            };
          });

          return {
            summary: {
              totalCount,
              totalStepsRemaining: totalStepsRemaining.toString(),
              totalValueRemaining: totalValueRemaining.toString(),
            },
            fractions: fractionsWithDerived,
          };
        };

        if (type) {
          return {
            type,
            ...computeSummary(fractions),
          };
        }

        const launchpadFractions = fractions.filter(
          (fraction) => fraction.type === "launchpad"
        );
        const miningCenterFractions = fractions.filter(
          (fraction) => fraction.type === "mining-center"
        );

        return {
          launchpad: computeSummary(launchpadFractions),
          miningCenter: computeSummary(miningCenterFractions),
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /available", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        type: t.Optional(
          t.Union([t.Literal("launchpad"), t.Literal("mining-center")])
        ),
      }),
      detail: {
        summary: "Get currently available fractions",
        description:
          "Returns committed fractions that have not expired yet. Optionally filter by fraction type to retrieve available launchpad or mining-center listings.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/default-max-splits",
    async ({ query: { applicationId }, set }) => {
      if (!applicationId) {
        set.status = 400;
        return "applicationId is required";
      }

      try {
        // Get the application to check if it has a custom maxSplits value
        const application = await FindFirstApplicationById(applicationId);
        if (!application) {
          set.status = 404;
          return "Application not found";
        }

        // If application has a custom maxSplits value (not 0), return it
        if (application.maxSplits && application.maxSplits !== "0") {
          return {
            maxSplits: application.maxSplits.toString(),
            isDefault: false,
            source: "application_override",
          };
        }

        // Otherwise, get the default maxSplits
        const defaultMaxSplitsResult = await findActiveDefaultMaxSplits();
        if (defaultMaxSplitsResult.length === 0) {
          set.status = 404;
          return "No default maxSplits configuration found";
        }

        return {
          maxSplits: defaultMaxSplitsResult[0].maxSplits.toString(),
          isDefault: true,
          source: "default_configuration",
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /default-max-splits", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        applicationId: t.String(),
      }),
      detail: {
        summary: "Get default or application-specific maxSplits value",
        description:
          "Returns the maxSplits value for an application - either the application-specific override or the default configuration. This determines the maximum number of fraction splits that can be sold for the application.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/splits-by-wallet",
    async ({ query: { walletAddress, fractionId }, set }) => {
      if (!walletAddress) {
        set.status = 400;
        return "walletAddress is required";
      }

      if (!fractionId) {
        set.status = 400;
        return "fractionId is required";
      }

      try {
        // Validate wallet address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
          set.status = 400;
          return "Invalid wallet address format";
        }

        // Validate fraction exists
        const fraction = await findFractionById(fractionId);
        if (!fraction) {
          set.status = 404;
          return "Fraction not found";
        }

        // Get splits for this wallet and fraction
        const splits = await findSplitsByWalletAndFraction(
          walletAddress.toLowerCase(),
          fractionId
        );

        // Calculate totals
        const totalStepsPurchased = splits.reduce(
          (sum, split) => sum + (split.stepsPurchased || 0),
          0
        );
        const totalAmountSpent = splits.reduce((sum, split) => {
          try {
            return sum + BigInt(split.amount);
          } catch {
            return sum;
          }
        }, BigInt(0));

        return {
          walletAddress,
          fractionId,
          splits,
          summary: {
            totalTransactions: splits.length,
            totalStepsPurchased,
            totalAmountSpent: totalAmountSpent.toString(),
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /splits-by-wallet", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Ethereum wallet address",
        }),
        fractionId: t.String({
          description: "Fraction ID (bytes32 hex string)",
        }),
      }),
      detail: {
        summary: "Get fraction splits owned by wallet for a specific fraction",
        description:
          "Returns all fraction splits purchased by a specific wallet address for a specific fraction, including transaction details and purchase summary with total steps purchased and amount spent.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/splits-activity",
    async ({ query: { limit, walletAddress }, set }) => {
      try {
        const parsedLimit = limit ? parseInt(limit) : 50;
        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
          set.status = 400;
          return "Limit must be a number between 1 and 200";
        }

        // Get recent splits activity
        const recentActivity = await findRecentSplitsActivity(parsedLimit, {
          buyerAddress: walletAddress,
        });

        const applicationIds = Array.from(
          new Set(recentActivity.map(({ fraction }) => fraction.applicationId))
        );

        // Batch fetch farm names
        const farmNamesMap = await getFarmNamesByApplicationIds(applicationIds);
        const appIdToFarmId = new Map<string, string>();
        if (applicationIds.length > 0) {
          try {
            const apps = await db.query.applications.findMany({
              columns: { id: true, farmId: true },
              where: (apps, { inArray }) => inArray(apps.id, applicationIds),
            });
            for (const app of apps) {
              if (app.farmId) appIdToFarmId.set(app.id, app.farmId);
            }
          } catch (error) {
            console.error(
              "Failed to batch fetch applications for farmId:",
              error
            );
          }
        }

        // Filter by wallet address if provided
        // Already filtered if walletAddress provided
        let filteredActivity = recentActivity;
        if (walletAddress) {
          if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
            set.status = 400;
            return "Invalid wallet address format";
          }
        }

        // Transform the data for better API response, filtering out invalid tokens
        const activityData = filteredActivity
          .map((activity) => {
            const { split, fraction } = activity;

            // Calculate progress percentage
            const progressPercent =
              fraction.totalSteps && fraction.splitsSold
                ? Math.round((fraction.splitsSold / fraction.totalSteps) * 100)
                : 0;

            const currency =
              forwarderAddresses.USDC.toLowerCase() ===
              fraction.token!.toLowerCase()
                ? "USDC"
                : fraction.token!.toLowerCase() ===
                  forwarderAddresses.GLW.toLowerCase()
                ? "GLW"
                : undefined;

            // Return null for invalid tokens to filter them out
            if (!currency) {
              return null;
            }

            return {
              // Split transaction details
              transactionHash: split.transactionHash,
              blockNumber: split.blockNumber,
              buyer: split.buyer,
              creator: split.creator,
              stepsPurchased: split.stepsPurchased,
              amount: split.amount,
              step: split.step,
              timestamp: split.timestamp,
              purchaseDate: split.createdAt,
              currency,
              fractionType: fraction.type,
              // Fraction context
              fractionId: fraction.id,
              applicationId: fraction.applicationId,
              farmId: appIdToFarmId.get(fraction.applicationId) ?? null,
              farmName: farmNamesMap.get(fraction.applicationId) || null,
              fractionStatus: fraction.status,
              isFilled: fraction.isFilled,
              progressPercent,
              rewardScore: fraction.rewardScore,

              // Purchase value calculation
              stepPrice: split.step,
              totalValue: split.amount,
            };
          })
          .filter((activity) => activity !== null);

        return {
          activity: activityData,
          summary: {
            totalTransactions: filteredActivity.length,
            totalStepsPurchased: filteredActivity.reduce(
              (sum, activity) => sum + (activity.split.stepsPurchased || 0),
              0
            ),
            totalAmountSpent: filteredActivity
              .reduce((sum, activity) => {
                try {
                  return sum + BigInt(activity.split.amount);
                } catch {
                  return sum;
                }
              }, BigInt(0))
              .toString(),
            uniqueBuyers: new Set(
              filteredActivity.map((activity) =>
                activity.split.buyer.toLowerCase()
              )
            ).size,
            uniqueFractions: new Set(
              filteredActivity.map((activity) => activity.fraction.id)
            ).size,
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /splits-activity", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        limit: t.Optional(
          t.String({
            description:
              "Number of recent splits to return (1-200, default: 50)",
          })
        ),
        walletAddress: t.Optional(
          t.String({
            pattern: "^0x[a-fA-F0-9]{40}$",
            description: "Filter by specific wallet address",
          })
        ),
      }),
      detail: {
        summary: "Get recent fraction splits purchase activity",
        description:
          "Returns recent fraction purchase activity across all fractions, with optional filtering by wallet address. Includes transaction details, fraction context, progress information, and activity summary statistics.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/splits-activity-by-type",
    async ({ query: { limit, fractionType }, set }) => {
      try {
        const parsedLimit = limit ? parseInt(limit) : 50;
        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
          set.status = 400;
          return "Limit must be a number between 1 and 200";
        }

        if (!fractionType) {
          set.status = 400;
          return "fractionType is required";
        }

        if (fractionType !== "mining-center" && fractionType !== "launchpad") {
          set.status = 400;
          return "fractionType must be either 'mining-center' or 'launchpad'";
        }

        // Get recent splits activity (filtered by type at the query level)
        const recentActivity = await findRecentSplitsActivity(parsedLimit, {
          fractionType,
        });

        // Already filtered by query above
        const filteredActivity = recentActivity;

        const applicationIds = Array.from(
          new Set(
            filteredActivity.map(({ fraction }) => fraction.applicationId)
          )
        );

        // Batch fetch farm names
        const farmNamesMap = await getFarmNamesByApplicationIds(applicationIds);
        const appIdToFarmId = new Map<string, string>();
        if (applicationIds.length > 0) {
          try {
            const apps = await db.query.applications.findMany({
              columns: { id: true, farmId: true },
              where: (apps, { inArray }) => inArray(apps.id, applicationIds),
            });
            for (const app of apps) {
              if (app.farmId) appIdToFarmId.set(app.id, app.farmId);
            }
          } catch (error) {
            console.error(
              "Failed to batch fetch applications for farmId:",
              error
            );
          }
        }

        // Transform the data for better API response, filtering out invalid tokens
        const activityData = filteredActivity
          .map((activity) => {
            const { split, fraction } = activity;

            // Calculate progress percentage
            const progressPercent =
              fraction.totalSteps && fraction.splitsSold
                ? Math.round((fraction.splitsSold / fraction.totalSteps) * 100)
                : 0;

            const currency =
              forwarderAddresses.USDC.toLowerCase() ===
              fraction.token!.toLowerCase()
                ? "USDC"
                : fraction.token!.toLowerCase() ===
                  forwarderAddresses.GLW.toLowerCase()
                ? "GLW"
                : undefined;

            // Return null for invalid tokens to filter them out
            if (!currency) {
              return null;
            }

            return {
              // Split transaction details
              transactionHash: split.transactionHash,
              blockNumber: split.blockNumber,
              buyer: split.buyer,
              creator: split.creator,
              stepsPurchased: split.stepsPurchased,
              amount: split.amount,
              step: split.step,
              timestamp: split.timestamp,
              purchaseDate: split.createdAt,
              currency,
              // Fraction context
              fractionId: fraction.id,
              applicationId: fraction.applicationId,
              farmId: appIdToFarmId.get(fraction.applicationId) ?? null,
              farmName: farmNamesMap.get(fraction.applicationId) || null,
              fractionType: fraction.type,
              fractionStatus: fraction.status,
              isFilled: fraction.isFilled,
              progressPercent,
              rewardScore: split.rewardScore || fraction.rewardScore,
              // Purchase value calculation
              stepPrice: split.step,
              totalValue: split.amount,
            };
          })
          .filter((activity) => activity !== null);

        return {
          activity: activityData,
          fractionType,
          summary: {
            totalTransactions: filteredActivity.length,
            totalStepsPurchased: filteredActivity.reduce(
              (sum, activity) => sum + (activity.split.stepsPurchased || 0),
              0
            ),
            totalAmountSpent: filteredActivity
              .reduce((sum, activity) => {
                try {
                  return sum + BigInt(activity.split.amount);
                } catch {
                  return sum;
                }
              }, BigInt(0))
              .toString(),
            uniqueBuyers: new Set(
              filteredActivity.map((activity) =>
                activity.split.buyer.toLowerCase()
              )
            ).size,
            uniqueFractions: new Set(
              filteredActivity.map((activity) => activity.fraction.id)
            ).size,
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /splits-activity-by-type", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        limit: t.Optional(
          t.String({
            description:
              "Number of recent splits to return (1-200, default: 50)",
          })
        ),
        fractionType: t.String({
          description:
            "Filter by fraction type: 'mining-center' or 'launchpad'",
        }),
      }),
      detail: {
        summary:
          "Get recent fraction splits purchase activity by fraction type",
        description:
          "Returns recent fraction purchase activity filtered by fraction type (mining-center or launchpad). Includes transaction details, fraction context, progress information, and activity summary statistics.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/refundable-by-wallet",
    async ({ query: { walletAddress }, set }) => {
      if (!walletAddress) {
        set.status = 400;
        return "walletAddress is required";
      }

      try {
        // Validate wallet address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
          set.status = 400;
          return "Invalid wallet address format";
        }

        // Get all refundable fractions for this wallet
        const refundableFractions = await findRefundableFractionsByWallet(
          walletAddress.toLowerCase()
        );

        // Calculate summary statistics
        const totalRefundableAmount = refundableFractions.reduce(
          (sum, item) => {
            try {
              return sum + BigInt(item.refundDetails.estimatedRefundAmount);
            } catch {
              return sum;
            }
          },
          BigInt(0)
        );

        const totalStepsPurchased = refundableFractions.reduce(
          (sum, item) => sum + item.userPurchaseData.totalStepsPurchased,
          0
        );

        return {
          walletAddress,
          refundableFractions,
          summary: {
            totalRefundableFractions: refundableFractions.length,
            totalRefundableAmount: totalRefundableAmount.toString(),
            totalStepsPurchased,
            // Group by status for frontend display
            byStatus: {
              expired: refundableFractions.filter(
                (item) => item.fraction.status === "expired"
              ).length,
              cancelled: refundableFractions.filter(
                (item) => item.fraction.status === "cancelled"
              ).length,
            },
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /refundable-by-wallet", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Ethereum wallet address",
        }),
      }),
      detail: {
        summary: "Get all refundable fractions for a wallet",
        description:
          "Returns all fractions where the wallet has purchased splits and the fractions are either expired or cancelled (and not filled), allowing for refunds. Includes all necessary data for the frontend to process refunds through the smart contract's claimRefund function.",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .get(
    "/by-id",
    async ({ query: { fractionId }, set }) => {
      if (!fractionId) {
        set.status = 400;
        return "fractionId is required";
      }

      try {
        const fraction = await findFractionById(fractionId);
        if (!fraction) {
          set.status = 404;
          return "Fraction not found";
        }

        const application = await FindFirstApplicationById(
          fraction.applicationId
        );
        if (!application) {
          set.status = 404;
          return "Associated application not found";
        }

        return {
          ...fraction,
          farmId: application.farmId,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[fractionsRouter] /by-id", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        fractionId: t.String(),
      }),
      detail: {
        summary: "Get fraction by ID",
        description: "Returns a specific fraction by its ID",
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .use(bearerplugin())
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .get(
        "/by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) {
            set.status = 400;
            return "applicationId is required";
          }

          try {
            const application = await FindFirstApplicationById(applicationId);
            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            // Check if user has access to this application
            if (application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            const fractions = await findFractionsByApplicationId(applicationId);
            return fractions;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Get fractions by application ID",
            description:
              "Returns all fractions created for a specific application",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/active-by-application-id",
        async ({ query: { applicationId }, set, userId }) => {
          if (!applicationId) {
            set.status = 400;
            return "applicationId is required";
          }

          try {
            const application = await FindFirstApplicationById(applicationId);
            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            // Check if user has access to this application
            if (application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            const activeFraction = await findActiveFractionByApplicationId(
              applicationId
            );

            if (!activeFraction) {
              set.status = 404;
              return "No active fraction found for this application";
            }

            return activeFraction;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /active-by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            applicationId: t.String(),
          }),
          detail: {
            summary: "Get active fraction by application ID",
            description:
              "Returns the active fraction for an application (not expired and not committed on-chain)",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/splits",
        async ({ query: { fractionId }, set, userId }) => {
          if (!fractionId) {
            set.status = 400;
            return "fractionId is required";
          }

          try {
            const fraction = await findFractionById(fractionId);
            if (!fraction) {
              set.status = 404;
              return "Fraction not found";
            }

            const application = await FindFirstApplicationById(
              fraction.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Associated application not found";
            }

            // Check if user has access to this fraction
            if (
              application.userId !== userId &&
              fraction.createdBy !== userId
            ) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            const splits = await findFractionSplits(fractionId);
            return {
              fractionId,
              totalSplits: splits.length,
              splits,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /splits", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            fractionId: t.String(),
          }),
          detail: {
            summary: "Get fraction splits by fraction ID",
            description: "Returns all splits (sales) for a specific fraction",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .post(
        "/create-mining-center-listing",
        async ({
          body: { applicationId, sponsorSplitPercent, stepPrice, totalSteps },
          set,
          userId,
        }) => {
          try {
            // Validate required fields
            if (!applicationId) {
              set.status = 400;
              return "applicationId is required";
            }

            if (
              sponsorSplitPercent === undefined ||
              sponsorSplitPercent === null
            ) {
              set.status = 400;
              return "sponsorSplitPercent is required";
            }

            // Check if application exists and user has access
            const application = await FindFirstApplicationById(applicationId);
            if (!application) {
              set.status = 404;
              return "Application not found";
            }

            // Check if user has access to this application
            if (application.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }

            if (
              userId.toLowerCase() !==
              forwarderAddresses.FOUNDATION_HUB_MANAGER_WALLET.toLowerCase()
            ) {
              set.status = 401;
              return "Unauthorized";
            }

            // Create the mining-center fraction
            const fraction = await createFraction({
              applicationId,
              createdBy: userId,
              sponsorSplitPercent,
              stepPrice,
              totalSteps,
              type: "mining-center",
            });

            return {
              success: true,
              fractionId: fraction.id,
              expirationAt: fraction.expirationAt,
              message: "Mining-center fraction created successfully",
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /create-mining-center-listing", e);
            throw new Error("Error Occurred");
          }
        },
        {
          body: t.Object({
            applicationId: t.String({
              description: "The ID of the application to create a fraction for",
            }),
            sponsorSplitPercent: t.Number({
              minimum: 0,
              maximum: 100,
              description: "Sponsor split percentage (0-100)",
            }),
            totalSteps: t.Number({
              minimum: 1,
              description: "Total number of steps",
            }),
            stepPrice: t.String({
              description: "Price per step in token decimals (optional)",
            }),
          }),
          detail: {
            summary: "Create a new mining-center fraction",
            description:
              "Creates a new mining-center type fraction for an application. Mining-center fractions use USDC tokens",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
      .get(
        "/mining-center",
        async ({ set, userId }) => {
          try {
            // Get all mining-center fractions for the authenticated user
            const miningCenterFractions =
              await findMiningCenterFractionsByUserId(userId);

            // Calculate summary statistics
            const summary = {
              totalFractions: miningCenterFractions.length,
              totalStepsAvailable: miningCenterFractions.reduce(
                (sum, fraction) => sum + (fraction.totalSteps || 0),
                0
              ),
              totalStepsSold: miningCenterFractions.reduce(
                (sum, fraction) => sum + (fraction.splitsSold || 0),
                0
              ),
              statusBreakdown: {
                draft: miningCenterFractions.filter((f) => f.status === "draft")
                  .length,
                committed: miningCenterFractions.filter(
                  (f) => f.status === "committed"
                ).length,
                filled: miningCenterFractions.filter(
                  (f) => f.status === "filled"
                ).length,
                cancelled: miningCenterFractions.filter(
                  (f) => f.status === "cancelled"
                ).length,
                expired: miningCenterFractions.filter(
                  (f) => f.status === "expired"
                ).length,
              },
            };

            return {
              fractions: miningCenterFractions,
              summary,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[fractionsRouter] /mining-center", e);
            throw new Error("Error Occurred");
          }
        },
        {
          detail: {
            summary:
              "Get all mining-center fractions for the authenticated user",
            description:
              "Returns all mining-center type fractions created by the authenticated user, including summary statistics about the fractions' status and progress.",
            tags: [TAG.APPLICATIONS],
          },
        }
      )
  );
