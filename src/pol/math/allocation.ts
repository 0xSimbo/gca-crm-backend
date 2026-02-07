/**
 * Deterministic proportional allocation by integer weights.
 * - If totalWeight == 0, falls back to even split.
 * - Ensures sum(allocations) == amount by distributing remainder to earliest keys.
 */
export function allocateAmountByWeights(params: {
  amount: bigint;
  weightsByKey: Map<string, bigint>;
}): Map<string, bigint>;

export function allocateAmountByWeights(params: {
  amount: bigint;
  weightsByKey: Map<number, bigint>;
}): Map<number, bigint>;

export function allocateAmountByWeights<K extends string | number>(params: {
  amount: bigint;
  weightsByKey: Map<K, bigint>;
}): Map<K, bigint> {
  const { amount, weightsByKey } = params;
  const keys = Array.from(weightsByKey.keys());
  keys.sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    const as = String(a);
    const bs = String(b);
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
  });

  const out = new Map<K, bigint>();
  if (keys.length === 0) return out;

  let totalWeight = 0n;
  for (const k of keys) {
    const w = weightsByKey.get(k) ?? 0n;
    if (w < 0n) throw new Error("Negative weight not allowed");
    totalWeight += w;
  }

  if (totalWeight === 0n) {
    const base = amount / BigInt(keys.length);
    let remainder = amount % BigInt(keys.length);
    for (const k of keys) {
      const extra = remainder > 0n ? 1n : 0n;
      if (remainder > 0n) remainder -= 1n;
      out.set(k, base + extra);
    }
    return out;
  }

  let allocated = 0n;
  for (const k of keys) {
    const w = weightsByKey.get(k) ?? 0n;
    const share = (amount * w) / totalWeight;
    out.set(k, share);
    allocated += share;
  }

  // Distribute remainder deterministically.
  let remainder = amount - allocated;
  for (const k of keys) {
    if (remainder === 0n) break;
    out.set(k, (out.get(k) ?? 0n) + 1n);
    remainder -= 1n;
  }
  return out;
}
