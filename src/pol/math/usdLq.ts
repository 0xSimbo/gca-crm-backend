import { Decimal } from "./decimal";

/**
 * LQ has 12 decimals (sqrt(USDC6 * GLW18) = 1e12).
 */
export const LQ_DECIMALS = 12;
export const USDC_DECIMALS = 6;

function decimalFromAtomic(atomic: bigint, decimals: number): Decimal {
  return new Decimal(atomic.toString()).div(new Decimal(10).pow(decimals));
}

function atomicFromDecimal(value: Decimal, decimals: number): bigint {
  const scaled = value.mul(new Decimal(10).pow(decimals));
  // decimal.js-light does not implement `floor()`, so we use `toFixed` with explicit rounding.
  return BigInt(scaled.toFixed(0, Decimal.ROUND_FLOOR));
}

/**
 * Converts USD (USDC6 atomic) into LQ (12-decimal atomic) using the plan formula:
 *   lq = usd / (2 * sqrt(spotPrice))
 *
 * Where `spotPrice` is USDG per GLW as a decimal string with 6 decimals.
 */
export function usdUsdc6ToLqAtomic(params: {
  usdUsdc6: bigint;
  spotPriceUsdgPerGlw: string;
}): bigint {
  const usd = decimalFromAtomic(params.usdUsdc6, USDC_DECIMALS);
  const price = new Decimal(params.spotPriceUsdgPerGlw);
  if (price.lte(0)) throw new Error("spotPrice must be > 0");
  const lq = usd.div(new Decimal(2).mul(price.sqrt()));
  return atomicFromDecimal(lq, LQ_DECIMALS);
}

/**
 * Converts LQ (12-decimal atomic) into USD (USDC6 atomic) using the plan formula:
 *   usd = 2 * lq * sqrt(spotPrice)
 */
export function lqAtomicToUsdUsdc6(params: {
  lqAtomic: bigint;
  spotPriceUsdgPerGlw: string;
}): bigint {
  const lq = decimalFromAtomic(params.lqAtomic, LQ_DECIMALS);
  const price = new Decimal(params.spotPriceUsdgPerGlw);
  if (price.lte(0)) throw new Error("spotPrice must be > 0");
  const usd = new Decimal(2).mul(lq).mul(price.sqrt());
  return atomicFromDecimal(usd, USDC_DECIMALS);
}
