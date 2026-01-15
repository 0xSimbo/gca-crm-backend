import { getStateFromCoordinates } from "../lib/geography/get-state-from-lat-long";
import { statesWithEscalatorFees } from "../lib/geography/state-with-escalator-fees";

/** Mirrors the sheet’s “Calculations” tab defaults */
export const protocolFeeAssumptions = {
  // carbon debt per kWh block (left side)
  carbonFootprint: 40, // g CO2 / kWh  (B2)
  solarIrradiation: 2400, // h / year      (B4)
  performanceRatio: 0.8, // (B5)
  panelLifetime: 30, // years         (B6)

  // uncertainty & risk
  uncertaintyMultiplier: 0.35, // 35% (B8)
  disasterRisk: 0.0017, // 0.17%/yr  (F21)  – same value shown in B12 notes

  // program/finance
  commitmentPeriod: 30, // years (B13 / F22) – Sheet uses 30. (Was 10 in your code.)
  numberOfDaysPerYear: 365.25,
  cashflowDiscount: 0.075, // 7.5% - matches spreadsheet cashflow discount rate
  lebanonDiscountRate: 0.35, // 35% - Lebanon-only discount rate
};

export type CalculationParms = {
  /**
   * Plant nameplate in **MW** (matches the sheet cell labeled "Power Output (MWh)" but it is a rate).
   * Keep the name for API compatibility, but semantically it is MW.
   */
  powerOutputMWH: number;
  /** NASA API – average sun hours per day */
  hoursOfSunlightPerDay: number;
  /** Carbon offsets per MWh (tCO2e/MWh) */
  carbonOffsetsPerMWH: number;
};

/** === Helpers that mirror the sheet exactly === */

/** B7: total carbon debt per kWh BEFORE uncertainty */
export const totalCarbonDebtPerKwh = () => {
  // B3 = B2 / 1,000,000 converts grams→metric tons per kWh
  const tonsCO2PerKWh = protocolFeeAssumptions.carbonFootprint / 1_000_000;
  // B7 = B3 * B4 * B5 * B6
  return (
    tonsCO2PerKWh *
    protocolFeeAssumptions.solarIrradiation *
    protocolFeeAssumptions.performanceRatio *
    protocolFeeAssumptions.panelLifetime
  );
};

/** B9: adjusted carbon debt per kWh (adds uncertainty) */
export const adjustedDebtPerKWh = () => {
  return (
    totalCarbonDebtPerKwh() * (1 + protocolFeeAssumptions.uncertaintyMultiplier)
  );
};

/**
 * Right block E17–F24
 * - E17: total carbon debt adjusted (kWh)    -> adjustedDebtPerKWh()
 * - F18: Power Output (MWh) (rate in MW)     -> args.powerOutputMWH
 * - F19: convert to kW = F18 * 1000
 * - F20: Total Carbon Debt produced = E17 * F19
 * - F23: Adjusted Total Carbon Debt = F20 * (1 + disasterRisk)^years
 * - F24: Weekly Total Carbon Debt = F23 / (52 * years)
 */
function weeklyCarbonDebtMWBased(
  powerOutputMW: number,
  years: number,
  disasterRisk: number
) {
  const debtPerKWhAdj = adjustedDebtPerKWh(); // E17
  const plantKW = powerOutputMW * 1000; // F19
  const totalDebt = debtPerKWhAdj * plantKW; // F20 (units: tons/week-equivalent numerator)
  const adjustedTotalDebt = totalDebt * Math.pow(1 + disasterRisk, years); // F23
  const weeklyDebt = adjustedTotalDebt / (52 * years); // F24
  return weeklyDebt;
}

/**
 * Left-bottom B17–B23
 * - B19 = B17 * B18 * 7         (weekly MWh)
 * - B21 = B19 * B20             (weekly credits pre-uncertainty)
 * - B23 = B21 * (1 - B22)       (adjusted weekly credits)
 */
function weeklyAdjustedCredits(
  powerOutputMW: number,
  sunHoursPerDay: number,
  offsetsPerMWh: number,
  uncertainty: number
) {
  const weeklyMWh = powerOutputMW * sunHoursPerDay * 7; // B19
  const weeklyCredits = weeklyMWh * offsetsPerMWh; // B21
  return weeklyCredits * (1 - uncertainty); // B23
}

export function estimateProductionAndDebt(args: CalculationParms) {
  const years = protocolFeeAssumptions.commitmentPeriod;

  // Credits (left side)
  const adjustedWeeklyCredits = weeklyAdjustedCredits(
    args.powerOutputMWH, // MW nameplate
    args.hoursOfSunlightPerDay,
    args.carbonOffsetsPerMWH,
    protocolFeeAssumptions.uncertaintyMultiplier
  );

  // Debt (right side)
  const weeklyCarbonDebt = weeklyCarbonDebtMWBased(
    args.powerOutputMWH, // MW nameplate
    years,
    protocolFeeAssumptions.disasterRisk
  );

  // For completeness if you need total adjusted carbon debt (F23)
  const adjustedCarbonDebt = weeklyCarbonDebt * 52 * years; // inverse of F24

  return {
    adjustedWeeklyCredits,
    adjustedCarbonDebt,
    weeklyCarbonDebt,
    // optional net like the sheet’s B25: B23 - F24
    netWeeklyCredits: adjustedWeeklyCredits - weeklyCarbonDebt,
  };
}

/** ----------------- Protocol Fees PV block (your function kept) ----------------- */

export type EstimateProtocolFeeArgs = {
  powerOutputMWH: number; // MW nameplate (kept for compatibility)
  hoursOfSunlightPerDay: number; // NASA avg
  electricityPricePerKWH: number;
  cashflowDiscount: number; // use args.cashflowDiscount to override default
  latitude: number;
  longitude: number;
  escalatorReference: number | undefined;
};

export async function estimateProtocolFees(args: EstimateProtocolFeeArgs) {
  // First-year revenue from electricity (not carbon): price * kWh in year 1
  const firstYearPrice =
    args.electricityPricePerKWH *
    args.powerOutputMWH * // MW
    1000 * // → kW
    args.hoursOfSunlightPerDay *
    protocolFeeAssumptions.numberOfDaysPerYear;

  const foundState = await getStateFromCoordinates({
    latitude: args.latitude,
    longitude: args.longitude,
  });
  if (!foundState) throw new Error("State not found");

  let escalatorReference =
    args.escalatorReference ??
    statesWithEscalatorFees.find(
      ({ state }) =>
        state.replace(/ /g, "").toLowerCase() ===
        foundState.replace(/ /g, "").toLowerCase()
    )?.percent ??
    0.0331; // default

  const years = protocolFeeAssumptions.commitmentPeriod;
  // Present value of the *growing* revenue stream over N years
  const pv = calculatePV(
    -escalatorReference, // negative rate here matches your existing sign convention
    years,
    firstYearPrice
  );

  const protocolFees = calculatePV(args.cashflowDiscount, years, pv / years);

  return {
    firstYearPrice,
    presentValue: pv,
    protocolFees,
    state: foundState,
    escalatorReference,
  };
}

function calculatePV(
  rate: number,
  nper: number,
  pmt: number,
  type: number = 0
): number {
  if (rate === 0) return -(pmt * nper);
  const pvFactor = Math.pow(1 + rate, -nper);
  const pv = (-pmt * (1 + rate * type) * (1 - pvFactor)) / rate;
  return -pv;
}
