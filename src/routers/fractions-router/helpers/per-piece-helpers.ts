import { db } from "../../../db/db";
import { fractions, applications, fractionSplits } from "../../../db/schema";
import { eq, and, lte, sql, or, isNull } from "drizzle-orm";
import { FRACTION_STATUS } from "../../../constants/fractions";
import { getEpochEndDate } from "./apy-helpers";

export interface FarmStepStats {
  farmId: string;
  appId: string;
  type: "launchpad" | "mining-center";
  totalStepsSold: number;
  weightedAverageStepPrice: string;
  filledFractionsCount: number;
}

export async function getFilledStepStatsByFarm(
  endWeek: number
): Promise<Map<string, Map<"launchpad" | "mining-center", FarmStepStats>>> {
  const epochEndDate = getEpochEndDate(endWeek);

  const results = await db
    .select({
      farmId: applications.farmId,
      appId: sql<string>`MIN(${applications.id})`,
      type: fractions.type,
      totalStepsSold: sql<number>`COALESCE(SUM(${fractions.splitsSold}), 0)`,
      totalWeightedValue: sql<string>`COALESCE(SUM(CAST(${fractions.stepPrice} AS NUMERIC) * ${fractions.splitsSold}), 0)`,
      filledFractionsCount: sql<number>`COUNT(*)`,
    })
    .from(fractions)
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .where(
      and(
        sql`(
          (${fractions.type} = 'launchpad' AND ${fractions.status} = ${FRACTION_STATUS.FILLED})
          OR
          (${fractions.type} = 'mining-center' AND ${fractions.status} IN (${FRACTION_STATUS.FILLED}, ${FRACTION_STATUS.EXPIRED}))
        )`,
        or(
          lte(fractions.filledAt, epochEndDate),
          and(
            isNull(fractions.filledAt),
            lte(fractions.expirationAt, epochEndDate)
          )
        )
      )
    )
    .groupBy(applications.farmId, fractions.type);

  const farmStatsMap = new Map<
    string,
    Map<"launchpad" | "mining-center", FarmStepStats>
  >();

  for (const row of results) {
    if (!row.farmId) continue;
    if (row.type !== "launchpad" && row.type !== "mining-center") continue;

    const totalStepsSold = Number(row.totalStepsSold);
    if (totalStepsSold === 0) continue;

    const totalWeightedValue = BigInt(row.totalWeightedValue || "0");
    const weightedAverageStepPrice = (
      totalWeightedValue / BigInt(totalStepsSold)
    ).toString();
    const filledFractionsCount = Number(row.filledFractionsCount);

    if (!farmStatsMap.has(row.farmId)) {
      farmStatsMap.set(row.farmId, new Map());
    }

    const existingStats = farmStatsMap.get(row.farmId)!.get(row.type);
    if (existingStats) {
      const combinedStepsSold = existingStats.totalStepsSold + totalStepsSold;
      const existingWeightedTotal =
        BigInt(existingStats.weightedAverageStepPrice) *
        BigInt(existingStats.totalStepsSold);
      const newWeightedTotal =
        BigInt(weightedAverageStepPrice) * BigInt(totalStepsSold);
      const combinedWeightedAvg = (
        (existingWeightedTotal + newWeightedTotal) /
        BigInt(combinedStepsSold)
      ).toString();

      farmStatsMap.get(row.farmId)!.set(row.type, {
        farmId: row.farmId,
        appId: existingStats.appId,
        type: row.type,
        totalStepsSold: combinedStepsSold,
        weightedAverageStepPrice: combinedWeightedAvg,
        filledFractionsCount:
          existingStats.filledFractionsCount + filledFractionsCount,
      });
    } else {
      farmStatsMap.get(row.farmId)!.set(row.type, {
        farmId: row.farmId,
        appId: row.appId,
        type: row.type,
        totalStepsSold,
        weightedAverageStepPrice,
        filledFractionsCount,
      });
    }
  }

  return farmStatsMap;
}

export interface FarmParticipants {
  uniqueDelegators: number;
  uniqueMiners: number;
}

export async function getWalletPurchaseTypesByFarmUpToWeek(params: {
  endWeek: number;
  farmId?: string;
}): Promise<{
  walletToFarmTypes: Map<
    string,
    Map<string, Set<"launchpad" | "mining-center">>
  >;
  farmParticipants: Map<string, FarmParticipants>;
  appIdByFarmId: Map<string, string>;
}> {
  const { endWeek, farmId } = params;
  const epochEndDate = getEpochEndDate(endWeek);

  const whereParts = [
    sql`(
      (${fractions.type} = 'launchpad' AND ${fractions.status} = ${FRACTION_STATUS.FILLED})
      OR
      (${fractions.type} = 'mining-center' AND ${fractions.status} IN (${FRACTION_STATUS.FILLED}, ${FRACTION_STATUS.EXPIRED}))
    )`,
    or(
      lte(fractions.filledAt, epochEndDate),
      and(isNull(fractions.filledAt), lte(fractions.expirationAt, epochEndDate))
    ),
  ];

  if (farmId) {
    whereParts.push(eq(applications.farmId, farmId));
  }

  const rows = await db
    .select({
      walletAddress: sql<string>`lower(${fractionSplits.buyer})`,
      farmId: applications.farmId,
      appId: sql<string>`MIN(${applications.id})`,
      fractionType: fractions.type,
    })
    .from(fractionSplits)
    .innerJoin(fractions, eq(fractionSplits.fractionId, fractions.id))
    .innerJoin(applications, eq(fractions.applicationId, applications.id))
    .where(and(...whereParts))
    .groupBy(
      sql`lower(${fractionSplits.buyer})`,
      applications.farmId,
      fractions.type
    );

  const walletToFarmTypes = new Map<
    string,
    Map<string, Set<"launchpad" | "mining-center">>
  >();
  const delegatorsByFarm = new Map<string, Set<string>>();
  const minersByFarm = new Map<string, Set<string>>();
  const appIdByFarmId = new Map<string, string>();

  for (const row of rows) {
    if (!row.farmId) continue;
    if (
      row.fractionType !== "launchpad" &&
      row.fractionType !== "mining-center"
    ) {
      continue;
    }

    const wallet = row.walletAddress.toLowerCase();
    if (!walletToFarmTypes.has(wallet)) {
      walletToFarmTypes.set(wallet, new Map());
    }

    const farmMap = walletToFarmTypes.get(wallet)!;
    if (!farmMap.has(row.farmId)) {
      farmMap.set(row.farmId, new Set());
    }
    farmMap.get(row.farmId)!.add(row.fractionType);

    if (!appIdByFarmId.has(row.farmId)) {
      appIdByFarmId.set(row.farmId, row.appId);
    }

    if (row.fractionType === "launchpad") {
      if (!delegatorsByFarm.has(row.farmId)) {
        delegatorsByFarm.set(row.farmId, new Set());
      }
      delegatorsByFarm.get(row.farmId)!.add(wallet);
    } else {
      if (!minersByFarm.has(row.farmId)) {
        minersByFarm.set(row.farmId, new Set());
      }
      minersByFarm.get(row.farmId)!.add(wallet);
    }
  }

  const allFarmIds = new Set<string>([
    ...delegatorsByFarm.keys(),
    ...minersByFarm.keys(),
  ]);
  const farmParticipants = new Map<string, FarmParticipants>();
  for (const id of allFarmIds) {
    farmParticipants.set(id, {
      uniqueDelegators: delegatorsByFarm.get(id)?.size ?? 0,
      uniqueMiners: minersByFarm.get(id)?.size ?? 0,
    });
  }

  return { walletToFarmTypes, farmParticipants, appIdByFarmId };
}
