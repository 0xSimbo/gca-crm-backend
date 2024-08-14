import { getStateFromCoordinates } from "../lib/geography/get-state-from-lat-long";
import { statesWithEscalatorFees } from "../lib/geography/state-with-escalator-fees";
export const protocolFeeAssumptions = {
  carbonFootprint: 40,
  solarIrradiation: 2400,
  performanceRatio: 0.8,
  panelLifetime: 30,
  uncertaintyMultiplier: 0.35,
  annualInterestRate: 0.0017,
  commitmentPeriod: 10,
  disasterRisk: 0.0017,
  numberOfDaysPerYear: 365.25,
  cashflowDiscount: 0.055,
};

export type CalculationParms = {
  powerOutputMWH: number;
  hoursOfSunlightPerDay: number; // from nasa api
  carbonOffsetsPerMWH: number;
};
export function estimateProductionAndDebt(args: CalculationParms) {
  //Production
  const weeklyProductionMWH =
    args.powerOutputMWH * 7 * args.hoursOfSunlightPerDay;
  const weeklyCredits = weeklyProductionMWH * args.carbonOffsetsPerMWH;
  const adjustedWeeklyCredits =
    weeklyCredits * (1 - protocolFeeAssumptions.uncertaintyMultiplier);

  //Debt
  const debtPerKwh = totalCarbonDebtPerKwh();
  const adjustedDebtPerKwh =
    debtPerKwh * (1 + protocolFeeAssumptions.uncertaintyMultiplier);

  const powerOutputKwh = args.powerOutputMWH * 1000;
  const totalCarbonDebtProduced = powerOutputKwh * adjustedDebtPerKwh;
  const adjustedCarbonDebt =
    totalCarbonDebtProduced *
    (1 + protocolFeeAssumptions.disasterRisk) **
      protocolFeeAssumptions.commitmentPeriod;

  const weeklyCarbonDebt =
    adjustedCarbonDebt / (52 * protocolFeeAssumptions.commitmentPeriod);
  return {
    adjustedWeeklyCredits: adjustedWeeklyCredits,
    adjustedCarbonDebt,
    weeklyCarbonDebt,
  };
}

export type EstimateProtocolFeeArgs = {
  powerOutputMWH: number;
  hoursOfSunlightPerDay: number; // from nasa api
  electricityPricePerKWH: number;
  cashflowDiscount: number;
  latitude: number;
  longitude: number;
  escalatorReference: number | undefined;
};
export async function estimateProtocolFees(args: EstimateProtocolFeeArgs) {
  const firstYearPrice =
    args.electricityPricePerKWH *
    args.powerOutputMWH *
    1000 *
    args.hoursOfSunlightPerDay *
    protocolFeeAssumptions.numberOfDaysPerYear;

  const foundState = await getStateFromCoordinates({
    latitude: args.latitude,
    longitude: args.longitude,
  });
  if (!foundState) {
    throw new Error("State not found");
  }

  let escalatorReference =
    args.escalatorReference ||
    statesWithEscalatorFees.find(({ state }) => {
      return (
        state.replaceAll(" ", "").toLowerCase() ==
        foundState.replaceAll(" ", "").toLowerCase()
      );
    })?.percent;

  if (!escalatorReference) {
    escalatorReference = 0.0331;
  }

  // const _presentValue = getPresentValue(
  //   firstYearPrice,
  //   args.escalatorReference,
  //   protocolFeeAssumptions.commitmentPeriod,
  // );
  const pv = calculatePV(
    -escalatorReference,
    protocolFeeAssumptions.commitmentPeriod,
    firstYearPrice
  );
  const protocolFees = calculatePV(
    args.cashflowDiscount,
    protocolFeeAssumptions.commitmentPeriod,
    pv / protocolFeeAssumptions.commitmentPeriod
  );

  return {
    firstYearPrice,
    presentValue: pv,
    protocolFees,
    state: foundState,
    escalatorReference,
  };
}
export const totalCarbonDebtPerKwh = () => {
  return (
    (protocolFeeAssumptions.carbonFootprint / 1000000) *
    protocolFeeAssumptions.solarIrradiation *
    protocolFeeAssumptions.performanceRatio *
    protocolFeeAssumptions.panelLifetime
  );
};

// export const calculatePresentValue = (
//   rate: number,
//   nper: number,
//   pmt: number,
// ) => {
//   const pvFactor = Math.pow(1 + rate, -nper);
//   const pv = (-pmt * (1 + rate) * (1 - pvFactor)) / rate;
//   return -pv;
// };
function calculatePV(
  rate: number,
  nper: number,
  pmt: number,
  type: number = 0
): number {
  console.log(
    `Rate: ${rate}, Number of Periods: ${nper}, Payment per Period: ${pmt}`
  );

  if (rate === 0) {
    console.log("Calculating PV without interest rate.");
    return -(pmt * nper);
  }

  const pvFactor = Math.pow(1 + rate, -nper);
  const pv = (-pmt * (1 + rate * type) * (1 - pvFactor)) / rate;
  console.log(`PV Factor: ${pvFactor}, Calculated PV: ${pv}`);

  return -pv;
}
