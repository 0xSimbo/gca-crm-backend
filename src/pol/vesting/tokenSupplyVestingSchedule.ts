import { Decimal } from "../math/decimal";
import { GENESIS_TIMESTAMP } from "../../constants/genesis-timestamp";
import { tokenSupplyOverTimeData } from "../../../data/tokenSupplyOverTimeData";

export type GlwVestingScheduleRow = {
  date: string; // YYYY-MM-DD
  unlocked: string; // integer GLW (not atomic)
};

export type GlwVestingBreakdownRow = {
  date: string; // YYYY-MM-DD
  total: string; // integer GLW (not atomic)
  solarFarms: string;
  grants: string;
  governance: string;
  ecosystem: string;
  earlyStageFunding: string;
  lateStageFunding: string;
  grantsBootstrap: string;
  earlyLiquidityBootstrap: string;
};

export type GlwVestingRules = {
  // Investor unlock begins 1 year after the day contracts are upgraded.
  // We align to the first schedule point on/after that threshold.
  contractUpgradeDateIso: string; // YYYY-MM-DD
  investorUnlockEndIso: string; // YYYY-MM-DD
  // Cumulative total unlocked at investorUnlockEndIso.
  endTotalTokens: bigint;
};

function getMonth0DateIso(): string {
  // Month 0 is the protocol genesis timestamp (not normalized to month start).
  return new Date(GENESIS_TIMESTAMP * 1000).toISOString().slice(0, 10);
}

function addMonthsIso(isoDate: string, monthsToAdd: number): string {
  const [y, m, d] = isoDate.split("-").map((p) => Number(p));
  const base = new Date(Date.UTC(y, m - 1, d));
  const out = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthsToAdd, base.getUTCDate()));
  return out.toISOString().slice(0, 10);
}

function millionsToTokensIntString(millions: unknown): string {
  // The dataset is in "millions of GLW" with 3 decimal places.
  // We expose `unlocked` as whole-token integers.
  const dec = new Decimal(String(millions ?? "0"));
  return dec.mul(1_000_000).toFixed(0, Decimal.ROUND_HALF_UP);
}

function millionsToTokensBigInt(millions: Decimal): bigint {
  const asInt = millions.mul(1_000_000).toFixed(0, Decimal.ROUND_HALF_UP);
  return BigInt(asInt);
}

function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map((p) => Number(p));
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function monthIndexForDateCeil(params: {
  month0Iso: string;
  maxMonth: number;
  thresholdIso: string;
}): number {
  const threshold = isoToDate(params.thresholdIso).getTime();
  for (let month = 0; month <= params.maxMonth; month++) {
    const iso = addMonthsIso(params.month0Iso, month);
    if (isoToDate(iso).getTime() >= threshold) return month;
  }
  return params.maxMonth;
}

function computeLinearUnlockMillions(params: {
  month: number;
  startMonth: number;
  endMonth: number;
  finalMillions: Decimal;
}): Decimal {
  if (params.month <= params.startMonth) return new Decimal(0);
  if (params.month >= params.endMonth) return params.finalMillions;
  const elapsed = params.month - params.startMonth;
  const denom = params.endMonth - params.startMonth;
  if (denom <= 0) return params.finalMillions;
  return params.finalMillions.mul(elapsed).div(denom);
}

function getDefaultRules(): GlwVestingRules {
  // If you need precision here, set env vars in deploy:
  // - GLW_CONTRACT_UPGRADE_DATE_ISO
  // - GLW_INVESTOR_UNLOCK_END_ISO
  // - GLW_END_TOTAL_TOKENS
  const contractUpgradeDateIso =
    process.env.GLW_CONTRACT_UPGRADE_DATE_ISO ?? "2026-02-07"; // Placeholder default.
  const investorUnlockEndIso =
    process.env.GLW_INVESTOR_UNLOCK_END_ISO ?? "2029-12-19";
  const endTotalTokens = BigInt(process.env.GLW_END_TOTAL_TOKENS ?? "180000000");
  return { contractUpgradeDateIso, investorUnlockEndIso, endTotalTokens };
}

export function getGlwVestingBreakdownFromTokenSupply(
  rules: GlwVestingRules = getDefaultRules()
): GlwVestingBreakdownRow[] {
  const month0 = getMonth0DateIso();

  // Determine final (fully unlocked) premine allocations from the dataset.
  // We treat these as caps, but shift their time-unlock to match the authoritative rule.
  let ecosystemFinal = new Decimal(0);
  let earlyStageFinal = new Decimal(0);
  let lateStageFinal = new Decimal(0);
  let maxMonth = 0;
  for (const r of tokenSupplyOverTimeData as Array<any>) {
    const m = Number(r?.Month);
    if (!Number.isFinite(m) || m < 0) continue;
    maxMonth = Math.max(maxMonth, m);
    const eco = new Decimal(String(r?.Ecosystem ?? 0));
    const early = new Decimal(String(r?.["Early Stage Funding"] ?? 0));
    const late = new Decimal(String(r?.["Late Stage Funding"] ?? 0));
    if (eco.gt(ecosystemFinal)) ecosystemFinal = eco;
    if (early.gt(earlyStageFinal)) earlyStageFinal = early;
    if (late.gt(lateStageFinal)) lateStageFinal = late;
  }

  const investorThresholdIso = addMonthsIso(rules.contractUpgradeDateIso, 12);
  const startMonth = monthIndexForDateCeil({
    month0Iso: month0,
    maxMonth,
    thresholdIso: investorThresholdIso,
  });
  const endMonth = monthIndexForDateCeil({
    month0Iso: month0,
    maxMonth,
    thresholdIso: rules.investorUnlockEndIso,
  });
  if (startMonth >= endMonth) {
    throw new Error(
      `Invalid vesting config: investor unlock start month (${startMonth}) must be < end month (${endMonth}).`
    );
  }

  // Scale only variable emissions buckets (Solar Farms / Grants / Governance) so that
  // total supply at endMonth equals the authoritative target, while keeping:
  // - bootstrap buckets fixed (6m + 12m)
  // - investor totals fixed (ecosystem+early+late caps)
  const endRow = (tokenSupplyOverTimeData as Array<any>).find(
    (r) => Number(r?.Month) === endMonth
  );
  const endSolarFarmsM = new Decimal(String(endRow?.["Solar Farms"] ?? 0));
  const endGrantsM = new Decimal(String(endRow?.Grants ?? 0));
  const endGovernanceM = new Decimal(String(endRow?.Governance ?? 0));
  const endGrantsBootstrapM = new Decimal(String(endRow?.["Grants Bootstrap"] ?? 0));
  const endEarlyLiquidityBootstrapM = new Decimal(
    String(endRow?.["Early Liquidity Bootstrap"] ?? 0)
  );

  const investorTotalCapM = ecosystemFinal.add(earlyStageFinal).add(lateStageFinal);
  const bootstrapsM = endGrantsBootstrapM.add(endEarlyLiquidityBootstrapM);
  const variableEndM = endSolarFarmsM.add(endGrantsM).add(endGovernanceM);
  const targetEndM = new Decimal(rules.endTotalTokens.toString()).div(1_000_000);
  const targetVariableEndM = targetEndM.sub(bootstrapsM).sub(investorTotalCapM);
  const variableScale =
    variableEndM.lte(0) ? new Decimal(1) : targetVariableEndM.div(variableEndM);

  const rows: GlwVestingBreakdownRow[] = [];
  for (const r of tokenSupplyOverTimeData as Array<any>) {
    const month = Number(r?.Month);
    if (!Number.isFinite(month) || month < 0) continue;
    if (month > endMonth) continue; // Schedule ends at the authoritative end month.

    const date = addMonthsIso(month0, month);

    const solarFarmsM = new Decimal(String(r?.["Solar Farms"] ?? 0)).mul(variableScale);
    const grantsM = new Decimal(String(r?.Grants ?? 0)).mul(variableScale);
    const governanceM = new Decimal(String(r?.Governance ?? 0)).mul(variableScale);
    const grantsBootstrapM = new Decimal(String(r?.["Grants Bootstrap"] ?? 0));
    const earlyLiquidityBootstrapM = new Decimal(
      String(r?.["Early Liquidity Bootstrap"] ?? 0)
    );

    // Override these three premine categories to follow the authoritative unlock window.
    const ecosystemM = computeLinearUnlockMillions({
      month,
      startMonth,
      endMonth,
      finalMillions: ecosystemFinal,
    });
    const earlyStageM = computeLinearUnlockMillions({
      month,
      startMonth,
      endMonth,
      finalMillions: earlyStageFinal,
    });
    const lateStageM = computeLinearUnlockMillions({
      month,
      startMonth,
      endMonth,
      finalMillions: lateStageFinal,
    });

    const solarFarms = millionsToTokensBigInt(solarFarmsM);
    const grants = millionsToTokensBigInt(grantsM);
    const governance = millionsToTokensBigInt(governanceM);
    const ecosystem = millionsToTokensBigInt(ecosystemM);
    const earlyStageFunding = millionsToTokensBigInt(earlyStageM);
    const lateStageFunding = millionsToTokensBigInt(lateStageM);
    const grantsBootstrap = millionsToTokensBigInt(grantsBootstrapM);
    const earlyLiquidityBootstrap = millionsToTokensBigInt(
      earlyLiquidityBootstrapM
    );

    const total =
      solarFarms +
      grants +
      governance +
      ecosystem +
      earlyStageFunding +
      lateStageFunding +
      grantsBootstrap +
      earlyLiquidityBootstrap;

    rows.push({
      date,
      total: total.toString(),
      solarFarms: solarFarms.toString(),
      grants: grants.toString(),
      governance: governance.toString(),
      ecosystem: ecosystem.toString(),
      earlyStageFunding: earlyStageFunding.toString(),
      lateStageFunding: lateStageFunding.toString(),
      grantsBootstrap: grantsBootstrap.toString(),
      earlyLiquidityBootstrap: earlyLiquidityBootstrap.toString(),
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Make the end row total exact after integer rounding by adjusting ecosystem.
  const endIso = addMonthsIso(month0, endMonth);
  const endIdx = rows.findIndex((r) => r.date === endIso);
  if (endIdx >= 0) {
    const end = rows[endIdx];
    const diff = rules.endTotalTokens - BigInt(end.total);
    if (diff !== 0n) {
      const newEco = BigInt(end.ecosystem) + diff;
      rows[endIdx] = {
        ...end,
        ecosystem: newEco.toString(),
        total: (BigInt(end.total) + diff).toString(),
      };
    }
  }

  return rows;
}

export function getGlwVestingScheduleFromTokenSupply(
  rules?: GlwVestingRules
): GlwVestingScheduleRow[] {
  return getGlwVestingBreakdownFromTokenSupply(rules).map((r) => ({
    date: r.date,
    unlocked: r.total,
  }));
}
