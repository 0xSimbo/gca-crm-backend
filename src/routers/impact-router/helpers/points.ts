import { formatUnits } from "viem";

export const GLW_DECIMALS = BigInt(1_000_000_000_000_000_000);
export const POINTS_SCALE = BigInt(1_000_000); // 6 decimals

export interface PointsBreakdownScaled6 {
  inflationPointsScaled6: bigint;
  steeringPointsScaled6: bigint;
  vaultBonusPointsScaled6: bigint;
  rolloverPointsPreMultiplierScaled6: bigint;
  rolloverMultiplier: number;
  rolloverPointsScaled6: bigint;
  continuousPointsScaled6: bigint;
  totalPointsScaled6: bigint;
}

export function formatPointsScaled6(pointsScaled6: bigint): string {
  return formatUnits(pointsScaled6, 6);
}

export function formatGlwWei(glwWei: bigint): string {
  return formatUnits(glwWei, 18);
}

export function glwWeiToPointsScaled6(
  glwWei: bigint,
  pointsPerGlwScaled6: bigint
): bigint {
  if (glwWei <= BigInt(0)) return BigInt(0);
  return (glwWei * pointsPerGlwScaled6) / GLW_DECIMALS;
}

export function addScaled6Points(values: bigint[]): bigint {
  let sum = BigInt(0);
  for (const v of values) sum += v;
  return sum;
}

export function clampToZero(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}
