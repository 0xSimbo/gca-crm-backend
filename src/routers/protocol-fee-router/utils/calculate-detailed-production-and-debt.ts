import { getSunlightHoursAndCertificates } from "./get-sunlight-hours-and-certificates";
import { protocolFeeAssumptions } from "../../../constants/protocol-fee-assumptions";
import { Coordinates } from "../../../types";

interface CalculateDetailedProductionAndDebtArgs extends Coordinates {
  /**
   * Nameplate power in MW (kept as `powerOutputMWH` for compatibility).
   * Energy per week is computed as MW * sunHours/day * 7.
   */
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
  // === Inputs / lookups ===
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

  // === Constants (mirror the sheet) ===
  const daysPerWeek = 7;
  const weeksPerYear = 52;

  const {
    carbonFootprint, // g CO2 / kWh (B2)
    solarIrradiation, // h / year       (B4)
    performanceRatio, //                (B5)
    panelLifetime, // years          (B6)
    uncertaintyMultiplier, // 35%            (B8)
    disasterRisk, // 0.17%          (F21)
    commitmentPeriod, // years          (F22 / B13)
  } = protocolFeeAssumptions;

  // === Sheet left block: carbon debt per kWh ===
  // B3: grams -> metric tons
  const gramsToMetricTons = 1 / 1_000_000;

  // B7: total carbon debt per kWh (raw, before uncertainty)
  const totalCarbonDebtPerKWh =
    carbonFootprint *
    gramsToMetricTons *
    solarIrradiation *
    performanceRatio *
    panelLifetime;

  // B9: adjusted carbon debt per kWh (adds uncertainty)
  const totalCarbonDebtAdjustedKWh =
    totalCarbonDebtPerKWh * (1 + uncertaintyMultiplier);

  // --- Weekly Production (B17–B23) ---
  const weeklyPowerProductionMWh =
    powerOutputMWH * average_sunlight * daysPerWeek; // B19
  const weeklyCarbonCredits =
    weeklyPowerProductionMWh * average_carbon_certificates; // B21
  const adjustedWeeklyCarbonCredits =
    weeklyCarbonCredits * (1 - uncertaintyMultiplier); // B23

  // --- Weekly Carbon Debt (E17–F24) ---
  const convertToKW = powerOutputMWH * 1000; // F19
  const totalCarbonDebtProduced = totalCarbonDebtAdjustedKWh * convertToKW; // F20
  const adjustedTotalCarbonDebt =
    totalCarbonDebtProduced * Math.pow(1 + disasterRisk, commitmentPeriod); // F23
  const weeklyTotalCarbonDebt =
    adjustedTotalCarbonDebt / (weeksPerYear * commitmentPeriod); // F24

  return {
    weeklyProduction: {
      powerOutputMWH: {
        value: powerOutputMWH,
        formula: "input (MW nameplate)",
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
        value: uncertaintyMultiplier,
        formula: "fixed",
        variables: { uncertaintyMultiplier },
      },
      weeklyPowerProductionMWh: {
        value: weeklyPowerProductionMWh,
        formula: "powerOutputMWH * hoursOfSunlightPerDay * 7",
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
        variables: {
          weeklyCarbonCredits,
          adjustmentDueToUncertainty: uncertaintyMultiplier,
        },
      },
    },
    weeklyCarbonDebt: {
      totalCarbonDebtPerKWh: {
        value: totalCarbonDebtPerKWh,
        formula:
          "(carbonFootprint/1e6) * solarIrradiation * performanceRatio * panelLifetime",
        variables: {
          carbonFootprint,
          solarIrradiation,
          performanceRatio,
          panelLifetime,
        },
      },
      totalCarbonDebtAdjustedKWh: {
        value: totalCarbonDebtAdjustedKWh,
        formula: "totalCarbonDebtPerKWh * (1 + uncertaintyMultiplier)",
        variables: {
          totalCarbonDebtPerKWh,
          uncertaintyMultiplier,
        },
      },
      powerOutputMWH: {
        value: powerOutputMWH,
        formula: "input (MW nameplate)",
        variables: { powerOutputMWH },
      },
      convertToKW: {
        value: convertToKW,
        formula: "powerOutputMWH * 1000",
        variables: { powerOutputMWH },
      },
      totalCarbonDebtProduced: {
        value: totalCarbonDebtProduced,
        formula: "totalCarbonDebtAdjustedKWh * convertToKW",
        variables: { totalCarbonDebtAdjustedKWh, convertToKW },
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
        variables: { totalCarbonDebtProduced, disasterRisk, commitmentPeriod },
      },
      weeklyTotalCarbonDebt: {
        value: weeklyTotalCarbonDebt,
        formula: "adjustedTotalCarbonDebt / (52 * commitmentPeriod)",
        variables: { adjustedTotalCarbonDebt, commitmentPeriod, weeksPerYear },
      },
    },
  };
}
