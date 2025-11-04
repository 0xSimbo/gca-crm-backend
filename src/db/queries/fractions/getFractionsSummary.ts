import { FRACTION_STATUS } from "../../../constants/fractions";
import { db } from "../../db";
import { fractions, fractionSplits } from "../../schema";
import { eq, inArray } from "drizzle-orm";

export interface FractionsSummary {
  totalGlwDelegated: string;
  totalMiningCenterVolume: string;
  launchpadContributors: number;
  miningCenterContributors: number;
}

export async function getFractionsSummary(): Promise<FractionsSummary> {
  const filledFractions = await db
    .select({
      id: fractions.id,
      type: fractions.type,
      stepPrice: fractions.stepPrice,
      splitsSold: fractions.splitsSold,
    })
    .from(fractions)
    .where(
      inArray(fractions.status, [
        FRACTION_STATUS.FILLED,
        FRACTION_STATUS.COMMITTED,
        FRACTION_STATUS.EXPIRED,
      ])
    );

  let launchpadTotal = BigInt(0);
  let miningCenterTotal = BigInt(0);

  const launchpadFractionIds: string[] = [];
  const miningCenterFractionIds: string[] = [];

  for (const fraction of filledFractions) {
    const stepPrice = fraction.stepPrice
      ? BigInt(fraction.stepPrice)
      : BigInt(0);
    const soldSteps = BigInt(fraction.splitsSold ?? 0);
    if (soldSteps === BigInt(0)) continue;
    const total = stepPrice * soldSteps;

    if (fraction.type === "launchpad") {
      launchpadTotal += total;
      launchpadFractionIds.push(fraction.id);
    } else if (fraction.type === "mining-center") {
      miningCenterTotal += total;
      miningCenterFractionIds.push(fraction.id);
    }
  }

  const launchpadContributors = await countContributors(launchpadFractionIds);
  const miningCenterContributors = await countContributors(
    miningCenterFractionIds
  );

  return {
    totalGlwDelegated: launchpadTotal.toString(),
    totalMiningCenterVolume: miningCenterTotal.toString(),
    launchpadContributors,
    miningCenterContributors,
  };
}

async function countContributors(fractionIds: string[]): Promise<number> {
  if (fractionIds.length === 0) {
    return 0;
  }

  const splits = await db
    .select({ buyer: fractionSplits.buyer })
    .from(fractionSplits)
    .where(inArray(fractionSplits.fractionId, fractionIds));

  const buyers = new Set<string>();
  for (const split of splits) {
    buyers.add(split.buyer.toLowerCase());
  }

  return buyers.size;
}
