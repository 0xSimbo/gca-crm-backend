import { db } from "../../../db/db";
import { fractions, applications } from "../../../db/schema";
import { eq, and, lte, sql, inArray } from "drizzle-orm";
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
      appId: applications.id,
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
        lte(fractions.filledAt, epochEndDate)
      )
    )
    .groupBy(applications.farmId, applications.id, fractions.type);

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
        filledFractionsCount: existingStats.filledFractionsCount + filledFractionsCount,
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

