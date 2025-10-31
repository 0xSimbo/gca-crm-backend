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
import { fractions, fractionSplits } from "../../db/schema";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { getCachedGlwSpotPriceNumber } from "../../utils/glw-spot";
import {
  getWeekRange,
  buildWalletFarmMap,
  calculateTotalRewards,
  aggregateRewardsByFarm,
  aggregateRewardsByWallet,
  type WalletFarmInfo,
} from "./helpers/apy-helpers";
import {
  calculateAccurateWalletAPY,
  getWalletFarmPurchases,
  getBatchWalletFarmPurchases,
} from "./helpers/accurate-apy-helpers";

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
          "Returns totals for GLW delegated via launchpad fractions and USD volume from mining-center fractions. Only filled fractions contribute to the totals.",
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

        const batchSize = 100;
        const allBatchRewards = new Map<string, any[]>();
        const allBatchPurchases = await getBatchWalletFarmPurchases(
          walletsToProcess
        );

        for (let i = 0; i < walletsToProcess.length; i += batchSize) {
          const batch = walletsToProcess.slice(i, i + batchSize);

          try {
            const response = await fetch(
              `${process.env.CONTROL_API_URL}/wallets/farm-rewards-history/batch`,
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
    async ({ query: { walletAddress, farmId, startWeek, endWeek }, set }) => {
      try {
        if (!process.env.CONTROL_API_URL) {
          set.status = 500;
          return "CONTROL_API_URL not configured";
        }

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

        const glwSpotPrice = await getCachedGlwSpotPriceNumber();

        if (walletAddress) {
          const walletLower = walletAddress.toLowerCase();

          const farmPurchases = await getWalletFarmPurchases(walletLower);

          if (farmPurchases.length === 0) {
            set.status = 404;
            return "Wallet not found or has no rewards";
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

          let totalGlwDelegated = BigInt(0);
          let totalMiningCenterVolume = BigInt(0);

          for (const purchase of farmPurchases) {
            if (purchase.type === "launchpad") {
              totalGlwDelegated += purchase.amountInvested;
            } else if (purchase.type === "mining-center") {
              totalMiningCenterVolume += purchase.amountInvested;
            }
          }

          const accurateAPY = await calculateAccurateWalletAPY(
            walletLower,
            actualStartWeek,
            actualEndWeek,
            glwSpotPrice
          );

          const delegatorApyPercent = accurateAPY.delegatorAPY.toFixed(4);
          const minerApyPercentFormatted = accurateAPY.minerAPY.toFixed(4);

          const farmDetails = accurateAPY.farmBreakdowns.map((farm) => ({
            farmId: farm.farmId,
            type: farm.type,
            amountInvested: farm.amountInvested.toString(),
            firstWeekWithRewards: farm.firstWeekWithRewards,
            totalWeeksEarned: farm.totalWeeksEarned,
            totalEarnedSoFar: farm.totalEarnedSoFar.toString(),
            lastWeekRewards: farm.lastWeekRewards.toString(),
            apy: farm.apy.toFixed(4),
          }));

          let delegatorLastWeek = BigInt(0);
          let delegatorAllWeeks = BigInt(0);
          let minerLastWeek = BigInt(0);
          let minerAllWeeks = BigInt(0);

          for (const farm of accurateAPY.farmBreakdowns) {
            if (farm.type === "launchpad") {
              delegatorLastWeek += farm.lastWeekRewards;
              delegatorAllWeeks += farm.totalEarnedSoFar;
            } else {
              minerLastWeek += farm.lastWeekRewards;
              minerAllWeeks += farm.totalEarnedSoFar;
            }
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
              totalUsdcSpentByMiners: totalMiningCenterVolume.toString(),
            },
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
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
            apy: {
              delegatorApyPercent,
              minerApyPercent: minerApyPercentFormatted,
            },
            farmDetails,
          };
        }

        if (farmId) {
          const walletFarmMap = await buildWalletFarmMap();
          const { walletBreakdowns } = await calculateTotalRewards(
            walletFarmMap,
            actualStartWeek,
            actualEndWeek
          );

          const farmAggregated = aggregateRewardsByFarm(walletBreakdowns);
          const farmData = farmAggregated.get(farmId);

          if (!farmData) {
            set.status = 404;
            return "Farm not found or has no rewards";
          }

          return {
            type: "farm",
            farmId,
            appId: farmData.appId,
            fractionTypes: farmData.fractionTypes,
            wallets: farmData.wallets,
            weekRange: {
              startWeek: actualStartWeek,
              endWeek: actualEndWeek,
            },
            rewards: {
              delegator: {
                lastWeek: farmData.delegatorRewards.lastWeek.toString(),
                allWeeks: farmData.delegatorRewards.allWeeks.toString(),
              },
              miner: {
                lastWeek: farmData.minerRewards.lastWeek.toString(),
                allWeeks: farmData.minerRewards.allWeeks.toString(),
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
