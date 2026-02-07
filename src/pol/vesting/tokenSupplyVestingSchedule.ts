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

function monthsBetweenIso(params: { startIso: string; endIso: string }): number {
  const [sy, sm] = params.startIso.split("-").map((p) => Number(p));
  const [ey, em] = params.endIso.split("-").map((p) => Number(p));
  return (ey - sy) * 12 + (em - sm);
}

const VESTING_RULES = {
  // Authoritative: Founding contributors / early investors unlock Dec 2026 to Dec 2029.
  // Month 0 is genesis date; we align the day-of-month by using the same YYYY-MM-DD format.
  earlyInvestorUnlockStartIso: "2026-12-19",
  earlyInvestorUnlockEndIso: "2029-12-19",
} as const;

export function getGlwVestingBreakdownFromTokenSupply(): GlwVestingBreakdownRow[] {
  const month0 = getMonth0DateIso();

  const startMonth = monthsBetweenIso({
    startIso: month0,
    endIso: VESTING_RULES.earlyInvestorUnlockStartIso,
  });
  const endMonth = monthsBetweenIso({
    startIso: month0,
    endIso: VESTING_RULES.earlyInvestorUnlockEndIso,
  });

  // Determine final (fully unlocked) premine allocations from the dataset.
  // We treat these as caps, but shift their time-unlock to match the authoritative rule.
  let ecosystemFinal = new Decimal(0);
  let earlyStageFinal = new Decimal(0);
  let lateStageFinal = new Decimal(0);
  for (const r of tokenSupplyOverTimeData as Array<any>) {
    const m = Number(r?.Month);
    if (!Number.isFinite(m) || m < 0) continue;
    const eco = new Decimal(String(r?.Ecosystem ?? 0));
    const early = new Decimal(String(r?.["Early Stage Funding"] ?? 0));
    const late = new Decimal(String(r?.["Late Stage Funding"] ?? 0));
    if (eco.gt(ecosystemFinal)) ecosystemFinal = eco;
    if (early.gt(earlyStageFinal)) earlyStageFinal = early;
    if (late.gt(lateStageFinal)) lateStageFinal = late;
  }

  const rows: GlwVestingBreakdownRow[] = [];
  for (const r of tokenSupplyOverTimeData as Array<any>) {
    const month = Number(r?.Month);
    if (!Number.isFinite(month) || month < 0) continue;

    const date = addMonthsIso(month0, month);

    const solarFarmsM = new Decimal(String(r?.["Solar Farms"] ?? 0));
    const grantsM = new Decimal(String(r?.Grants ?? 0));
    const governanceM = new Decimal(String(r?.Governance ?? 0));
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
  return rows;
}

export function getGlwVestingScheduleFromTokenSupply(): GlwVestingScheduleRow[] {
  return getGlwVestingBreakdownFromTokenSupply().map((r) => ({
    date: r.date,
    unlocked: r.total,
  }));
}
