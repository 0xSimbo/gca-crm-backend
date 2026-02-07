import { Decimal } from "../math/decimal";
import { GENESIS_TIMESTAMP } from "../../constants/genesis-timestamp";
import { tokenSupplyOverTimeData } from "../../../data/tokenSupplyOverTimeData";

export type GlwVestingScheduleRow = {
  date: string; // YYYY-MM-DD
  unlocked: string; // integer GLW (not atomic)
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

export function getGlwVestingScheduleFromTokenSupply(): GlwVestingScheduleRow[] {
  const month0 = getMonth0DateIso();

  const rows: GlwVestingScheduleRow[] = [];
  for (const r of tokenSupplyOverTimeData as Array<any>) {
    const month = Number(r?.Month);
    if (!Number.isFinite(month) || month < 0) continue;
    rows.push({
      date: addMonthsIso(month0, month),
      unlocked: millionsToTokensIntString(r?.Total),
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}
