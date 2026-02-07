import Decimal from "decimal.js-light";

export type VestingScheduleRow = {
  date: string; // YYYY-MM-DD
  unlocked: string; // decimal string
};

function isIsoDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/**
 * Parses a CSV with header `date,unlocked`.
 * - `date` must be `YYYY-MM-DD`
 * - `unlocked` is kept as a normalized decimal string (supports large values)
 */
export function parseVestingScheduleCsv(csv: string): VestingScheduleRow[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  if (header !== "date,unlocked") {
    throw new Error(`Invalid header: expected \"date,unlocked\", got \"${lines[0]}\"`);
  }

  const rows: VestingScheduleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [dateRaw, unlockedRaw, ...rest] = lines[i].split(",");
    if (rest.length > 0) {
      throw new Error(`Invalid row (too many columns) at line ${i + 1}`);
    }
    const date = (dateRaw ?? "").trim();
    const unlocked = (unlockedRaw ?? "").trim();
    if (!isIsoDate(date)) {
      throw new Error(`Invalid date at line ${i + 1}: \"${date}\"`);
    }
    if (unlocked.length === 0) {
      throw new Error(`Missing unlocked at line ${i + 1}`);
    }

    const normalizedUnlocked = new Decimal(unlocked).toString();
    rows.push({ date, unlocked: normalizedUnlocked });
  }

  // Make ingestion deterministic: stable sort by date.
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

