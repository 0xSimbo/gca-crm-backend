import { and, eq, gt, inArray } from "drizzle-orm";

import { FRACTION_STATUS } from "../../../constants/fractions";
import { isFractionVisibleOnMarketplace } from "../../../utils/fractions/marketplaceVisibility";
import { db } from "../../db";
import { fractions } from "../../schema";

const AVAILABLE_STATUSES = [FRACTION_STATUS.COMMITTED];

export interface GetAvailableFractionsOptions {
  type?: "launchpad" | "mining-center";
}

export async function getAvailableFractions(
  options: GetAvailableFractionsOptions = {}
) {
  const now = new Date();

  const conditions = [
    inArray(fractions.status, AVAILABLE_STATUSES),
    gt(fractions.expirationAt, now),
  ];

  if (options.type) {
    conditions.push(eq(fractions.type, options.type));
  }

  const rows = await db
    .select({
      id: fractions.id,
      applicationId: fractions.applicationId,
      createdBy: fractions.createdBy,
      createdAt: fractions.createdAt,
      stepPrice: fractions.stepPrice,
      totalSteps: fractions.totalSteps,
      splitsSold: fractions.splitsSold,
      expirationAt: fractions.expirationAt,
      status: fractions.status,
      type: fractions.type,
      rewardScore: fractions.rewardScore,
      token: fractions.token,
    })
    .from(fractions)
    .where(and(...conditions))
    .orderBy(fractions.expirationAt);

  return rows
    .filter((fraction) => isFractionVisibleOnMarketplace(fraction.createdAt, now))
    .map(({ createdAt: _createdAt, ...fraction }) => fraction);
}
