import { getSunlightHoursAndCertificates } from "./get-sunlight-hours-and-certificates";
import { protocolFeeAssumptions } from "../../../constants/protocol-fee-assumptions";
import { Coordinates } from "../../../types";

interface CalculateDetailedProductionAndDebtArgs extends Coordinates {
  powerOutputMWH: number;
  averageSunlightHoursPerDay?: number;
  averageCarbonCertificatesPerMWH?: number;
}

export interface DetailedProductionAndDebtResult {
  weeklyProduction: Record<string, any>;
  weeklyCarbonDebt: Record<string, any>;
}

export async function calculateDetailedProductionAndDebt({
  latitude,
  longitude,
  powerOutputMWH,
  averageSunlightHoursPerDay,
  averageCarbonCertificatesPerMWH,
}: CalculateDetailedProductionAndDebtArgs): Promise<DetailedProductionAndDebtResult> {
  // Get sunlight hours and carbon offset per MWh
  let average_sunlight: number;
  let average_carbon_certificates: number;

  if (
    typeof averageSunlightHoursPerDay === "number" &&
    typeof averageCarbonCertificatesPerMWH === "number"
  ) {
    average_sunlight = averageSunlightHoursPerDay;
    average_carbon_certificates = averageCarbonCertificatesPerMWH;
  } else {
    const result = await getSunlightHoursAndCertificates({
      latitude,
      longitude,
    });
    average_sunlight =
      typeof averageSunlightHoursPerDay === "number"
        ? averageSunlightHoursPerDay
        : result.average_sunlight;
    average_carbon_certificates =
      typeof averageCarbonCertificatesPerMWH === "number"
        ? averageCarbonCertificatesPerMWH
        : result.average_carbon_certificates;
  }

  // Constants
  const adjustmentDueToUncertainty =
    protocolFeeAssumptions.uncertaintyMultiplier; // 0.35
  const disasterRisk = protocolFeeAssumptions.disasterRisk; // 0.0017
  const commitmentPeriod = protocolFeeAssumptions.commitmentPeriod; // 10
  const totalCarbonDebtAdjustedKWh = 3.1104; // fixed for now
  const daysPerWeek = 7;
  const weeksPerYear = 52;

  // --- Weekly Production ---
  const weeklyPowerProductionMWh =
    powerOutputMWH * daysPerWeek * average_sunlight;
  const weeklyCarbonCredits =
    weeklyPowerProductionMWh * average_carbon_certificates;
  const adjustedWeeklyCarbonCredits =
    weeklyCarbonCredits * (1 - adjustmentDueToUncertainty);

  // --- Weekly Carbon Debt ---
  const convertToKW = powerOutputMWH * 1000;
  const totalCarbonDebtProduced =
    totalCarbonDebtAdjustedKWh * powerOutputMWH * 1000;
  const adjustedTotalCarbonDebt =
    totalCarbonDebtProduced * Math.pow(1 + disasterRisk, commitmentPeriod);
  const weeklyTotalCarbonDebt =
    adjustedTotalCarbonDebt / (weeksPerYear * commitmentPeriod);

  return {
    weeklyProduction: {
      powerOutputMWH: {
        value: powerOutputMWH,
        formula: "input",
        variables: { powerOutputMWH },
      },
      hoursOfSunlightPerDay: {
        value: average_sunlight,
        formula:
          averageSunlightHoursPerDay !== undefined
            ? "override"
            : "based on NASA data API",
        variables: { latitude, longitude },
      },
      carbonOffsetsPerMWH: {
        value: average_carbon_certificates,
        formula:
          averageCarbonCertificatesPerMWH !== undefined
            ? "override"
            : "based on WattTime data API",
        variables: { latitude, longitude },
      },
      adjustmentDueToUncertainty: {
        value: adjustmentDueToUncertainty,
        formula: "fixed",
        variables: { adjustmentDueToUncertainty },
      },
      weeklyPowerProductionMWh: {
        value: weeklyPowerProductionMWh,
        formula: "powerOutputMWH * hoursOfSunlightPerDay * daysPerWeek",
        variables: {
          powerOutputMWH,
          hoursOfSunlightPerDay: average_sunlight,
          daysPerWeek,
        },
      },
      weeklyCarbonCredits: {
        value: weeklyCarbonCredits,
        formula: "weeklyPowerProductionMWh * carbonOffsetsPerMWH",
        variables: {
          weeklyPowerProductionMWh,
          carbonOffsetsPerMWH: average_carbon_certificates,
        },
      },
      adjustedWeeklyCarbonCredits: {
        value: adjustedWeeklyCarbonCredits,
        formula: "weeklyCarbonCredits * (1 - adjustmentDueToUncertainty)",
        variables: { weeklyCarbonCredits, adjustmentDueToUncertainty },
      },
    },
    weeklyCarbonDebt: {
      totalCarbonDebtAdjustedKWh: {
        value: totalCarbonDebtAdjustedKWh,
        formula: "fixed",
        variables: { totalCarbonDebtAdjustedKWh },
      },
      powerOutputMWH: {
        value: powerOutputMWH,
        formula: "input",
        variables: { powerOutputMWH },
      },
      convertToKW: {
        value: convertToKW,
        formula: "powerOutputMWH * 1000",
        variables: { powerOutputMWH },
      },
      totalCarbonDebtProduced: {
        value: totalCarbonDebtProduced,
        formula: "totalCarbonDebtAdjustedKWh * powerOutputMWH * 1000",
        variables: { totalCarbonDebtAdjustedKWh, powerOutputMWH },
      },
      disasterRisk: {
        value: disasterRisk,
        formula: "fixed",
        variables: { disasterRisk },
      },
      commitmentPeriod: {
        value: commitmentPeriod,
        formula: "fixed",
        variables: { commitmentPeriod },
      },
      adjustedTotalCarbonDebt: {
        value: adjustedTotalCarbonDebt,
        formula:
          "totalCarbonDebtProduced * (1 + disasterRisk) ** commitmentPeriod",
        variables: {
          totalCarbonDebtProduced,
          disasterRisk,
          commitmentPeriod,
        },
      },
      weeklyTotalCarbonDebt: {
        value: weeklyTotalCarbonDebt,
        formula: "adjustedTotalCarbonDebt / (weeksPerYear * commitmentPeriod)",
        variables: {
          adjustedTotalCarbonDebt,
          weeksPerYear,
          commitmentPeriod,
        },
      },
    },
  };
}
