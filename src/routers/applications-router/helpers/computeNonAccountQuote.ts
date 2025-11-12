import { protocolFeeAssumptions } from "../../../constants/protocol-fee-assumptions";
import { getStateFromCoordinates } from "../../../lib/geography/get-state-from-lat-long";
import { statesWithEscalatorFees } from "../../../lib/geography/state-with-escalator-fees";
import { getSunlightHoursAndCertificates } from "../../protocol-fee-router/utils/get-sunlight-hours-and-certificates";
import { calculateFarmEfficiency } from "@glowlabs-org/utils/browser";

export interface ComputeQuoteParams {
  weeklyConsumptionMWh: number;
  systemSizeKw: number;
  electricityPricePerKwh: number;
  latitude: number;
  longitude: number;
  override?: {
    discountRate?: number;
    escalatorRate?: number;
    years?: number;
    carbonOffsetsPerMwh?: number; // allow override to avoid network during tests
  };
}

export interface ComputeQuoteResult {
  // Rates used
  discountRate: number;
  escalatorRate: number;
  years: number;

  // Protocol deposit
  protocolDepositUsd: number;
  protocolDepositUsd6: string; // scaled to 6 decimals

  // Carbon metrics
  weeklyCredits: number;
  weeklyDebt: number;
  netWeeklyCc: number;
  netCcPerMwh: number;
  carbonOffsetsPerMwh: number;
  uncertaintyApplied: number;

  // Efficiency
  weeklyImpactAssetsWad: string; // 18 decimals
  efficiencyScore: number;

  // Debug info
  debugJson: any;
}

/**
 * Present value of a growing annuity
 * PV = CF1 * (1 - ((1+g)/(1+r))^N) / (r - g)
 */
function presentValueGrowingAnnuity(
  CF1: number,
  r: number,
  g: number,
  N: number
): number {
  if (Math.abs(r - g) < 1e-9) {
    return (CF1 * N) / (1 + r);
  }
  return (CF1 * (1 - Math.pow((1 + g) / (1 + r), N))) / (r - g);
}

/**
 * Compute weekly carbon debt based on system size
 * Mirrors the sheet logic from protocol-fee-assumptions.ts
 */
function computeWeeklyCarbonDebt(systemSizeKw: number, years: number): number {
  const {
    carbonFootprint,
    solarIrradiation,
    performanceRatio,
    panelLifetime,
    uncertaintyMultiplier,
    disasterRisk,
  } = protocolFeeAssumptions;

  // B3: grams -> metric tons per kWh
  const tonsCO2PerKWh = carbonFootprint / 1_000_000;

  // B7: total carbon debt per kWh (before uncertainty)
  const totalCarbonDebtPerKWh =
    tonsCO2PerKWh * solarIrradiation * performanceRatio * panelLifetime;

  // B9: adjusted for uncertainty
  const adjustedDebtPerKWh =
    totalCarbonDebtPerKWh * (1 + uncertaintyMultiplier);

  // F19: convert to kW
  const plantKW = systemSizeKw;

  // F20: total debt produced
  const totalDebtProduced = adjustedDebtPerKWh * plantKW;

  // F23: adjusted for disaster risk over commitment period
  const adjustedTotalDebt =
    totalDebtProduced * Math.pow(1 + disasterRisk, years);

  // F24: weekly debt
  const weeklyDebt = adjustedTotalDebt / (52 * years);

  return weeklyDebt;
}

export async function computeNonAccountQuote(
  params: ComputeQuoteParams
): Promise<ComputeQuoteResult> {
  const {
    weeklyConsumptionMWh,
    systemSizeKw,
    electricityPricePerKwh,
    latitude,
    longitude,
    override,
  } = params;

  // Get rates from constants and geography
  const discountRate =
    override?.discountRate ?? protocolFeeAssumptions.cashflowDiscount;
  const years = override?.years ?? protocolFeeAssumptions.commitmentPeriod;

  // Get escalator rate from state
  let foundState: string | null = null;
  let escalatorRate = 0.0331; // default
  if (typeof override?.escalatorRate === "number") {
    escalatorRate = override.escalatorRate;
  } else {
    foundState = await getStateFromCoordinates({ latitude, longitude });
    if (foundState) {
      const stateEscalator = statesWithEscalatorFees.find(
        ({ state }) =>
          state.replace(/ /g, "").toLowerCase() ===
          foundState!.replace(/ /g, "").toLowerCase()
      );
      if (stateEscalator) {
        escalatorRate = stateEscalator.percent;
      }
    }
  }

  // Compute protocol deposit using growing annuity
  // Year-1 cash flow: weeklyConsumptionMWh * 1000 kWh * price * 52.18 weeks (actual weeks per year)
  const CF1 = weeklyConsumptionMWh * 1000 * electricityPricePerKwh * 52.18;
  const protocolDepositUsd = presentValueGrowingAnnuity(
    CF1,
    discountRate,
    escalatorRate,
    years
  );

  // Scale to 6 decimals for storage
  const protocolDepositUsd6 = Math.round(protocolDepositUsd * 1e6).toString();

  // Get carbon certificates from lat/lng
  const carbonOffsetsPerMwh =
    typeof override?.carbonOffsetsPerMwh === "number"
      ? override.carbonOffsetsPerMwh
      : (
          await getSunlightHoursAndCertificates({
            latitude,
            longitude,
          })
        ).average_carbon_certificates;

  const uncertaintyApplied = protocolFeeAssumptions.uncertaintyMultiplier;

  // Compute weekly credits
  const weeklyCredits =
    weeklyConsumptionMWh * carbonOffsetsPerMwh * (1 - uncertaintyApplied);

  // Compute weekly debt
  const weeklyDebt = computeWeeklyCarbonDebt(systemSizeKw, years);

  // Net carbon credits
  const netWeeklyCc = Math.max(0, weeklyCredits - weeklyDebt);
  const netCcPerMwh = netWeeklyCc / weeklyConsumptionMWh;

  // Compute efficiency using SDK util
  // Convert to proper scales: protocolDeposit in 6 decimals, weeklyImpact in 18 decimals
  const protocolDepositUsd6BigInt = BigInt(protocolDepositUsd6);
  const weeklyImpactAssetsWad = BigInt(
    Math.round(netWeeklyCc * 1e18)
  ).toString();
  const weeklyImpactAssetsWadBigInt = BigInt(weeklyImpactAssetsWad);

  const efficiencyScore = calculateFarmEfficiency(
    protocolDepositUsd6BigInt,
    weeklyImpactAssetsWadBigInt
  );

  // Build debug info
  const debugJson = {
    inputs: {
      weeklyConsumptionMWh,
      systemSizeKw,
      electricityPricePerKwh,
      latitude,
      longitude,
    },
    rates: {
      discountRate,
      escalatorRate,
      years,
      foundState,
    },
    protocolDeposit: {
      CF1,
      formula: "CF1 * (1 - ((1+g)/(1+r))^N) / (r - g)",
      protocolDepositUsd,
      protocolDepositUsd6,
    },
    carbonMetrics: {
      carbonOffsetsPerMwh,
      uncertaintyApplied,
      weeklyCredits,
      weeklyDebt,
      netWeeklyCc,
      netCcPerMwh,
    },
    efficiency: {
      weeklyImpactAssetsWad,
      efficiencyScore,
    },
  };

  return {
    discountRate,
    escalatorRate,
    years,
    protocolDepositUsd,
    protocolDepositUsd6,
    weeklyCredits,
    weeklyDebt,
    netWeeklyCc,
    netCcPerMwh,
    carbonOffsetsPerMwh,
    uncertaintyApplied,
    weeklyImpactAssetsWad,
    efficiencyScore,
    debugJson,
  };
}
