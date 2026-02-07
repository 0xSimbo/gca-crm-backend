/**
 * Evenly buckets an amount across `weeks` protocol weeks starting at `startWeek`.
 * The sum of outputs equals the input (remainder goes to the earliest weeks).
 */
export function bucketEvenlyAcrossWeeks(params: {
  amount: bigint;
  startWeek: number;
  weeks: number;
}): Array<{ week: number; amount: bigint }> {
  const { amount, startWeek, weeks } = params;
  if (!Number.isInteger(startWeek) || startWeek < 0)
    throw new Error("Invalid startWeek");
  if (!Number.isInteger(weeks) || weeks <= 0) throw new Error("Invalid weeks");

  const base = amount / BigInt(weeks);
  let remainder = amount % BigInt(weeks);

  const out: Array<{ week: number; amount: bigint }> = [];
  for (let i = 0; i < weeks; i++) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    out.push({ week: startWeek + i, amount: base + extra });
  }
  return out;
}

