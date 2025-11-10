import { FRACTION_STATUS } from "../../../constants/fractions";
import { db } from "../../db";
import { fractions, fractionSplits, applications } from "../../schema";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";

export interface FractionsSummary {
  totalGlwDelegated: string;
  totalMiningCenterVolume: string;
  launchpadContributors: number;
  miningCenterContributors: number;
  glwDelegationByEpoch: Record<number, string>;
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

  const glwDelegationByEpoch = await getGlwDelegationByEpoch(
    launchpadFractionIds
  );

  const glwPayments = await db
    .select({
      paymentAmount: applications.paymentAmount,
    })
    .from(applications)
    .where(
      and(
        eq(applications.paymentEventType, "PayProtocolFee"),
        eq(applications.paymentCurrency, "GLW")
      )
    );

  let glwPaymentsTotal = BigInt(0);
  for (const payment of glwPayments) {
    if (payment.paymentAmount) {
      try {
        glwPaymentsTotal += BigInt(payment.paymentAmount);
      } catch {
        // Skip invalid payment amounts
      }
    }
  }

  const totalGlwDelegated = launchpadTotal + glwPaymentsTotal;

  return {
    totalGlwDelegated: totalGlwDelegated.toString(),
    totalMiningCenterVolume: miningCenterTotal.toString(),
    launchpadContributors,
    miningCenterContributors,
    glwDelegationByEpoch,
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

async function getGlwDelegationByEpoch(
  fractionIds: string[]
): Promise<Record<number, string>> {
  if (fractionIds.length === 0) {
    return {};
  }

  const splits = await db
    .select({
      amount: fractionSplits.amount,
      timestamp: fractionSplits.timestamp,
    })
    .from(fractionSplits)
    .where(inArray(fractionSplits.fractionId, fractionIds));

  const epochTotals: Record<number, bigint> = {};

  for (const split of splits) {
    const epoch = getCurrentEpoch(split.timestamp);
    const amount = BigInt(split.amount);

    if (epochTotals[epoch]) {
      epochTotals[epoch] += amount;
    } else {
      epochTotals[epoch] = amount;
    }
  }

  const result: Record<number, string> = {};
  for (const [epoch, total] of Object.entries(epochTotals)) {
    result[Number(epoch)] = total.toString();
  }

  return result;
}
