import { Elysia, t, UnwrapSchema } from "elysia";
import { getRedisKey, setRedisKey } from "../../lib/redis-client";
import { TAG } from "../../constants";
import { getSunlightHoursAndCertificates } from "./utils/get-sunlight-hours-and-certificates";
import {
  estimateProtocolFees,
  EstimateProtocolFeeArgs,
  protocolFeeAssumptions,
} from "../../constants/protocol-fee-assumptions";
const LatitudeLongitudeQueryParamSchema = t.Object({
  //takes a string, but parses it into a float
  latitude: t
    .Transform(t.String())
    .Decode((v) => parseFloat(v))
    .Encode(String),
  //takes a string, but parses it into a float
  longitude: t.Transform(t.String()).Decode(parseFloat).Encode(String),
});

// type EstimateProtocolFeeArgs = {
//   powerOutputMWH: number;
//   hoursOfSunlightPerDay: number;
//   electricityPricePerKWH: number;
//   cashflowDiscount: number;
//   latitude: number;
//   longitude: number;
// }

const EstimateProtocolFeeArgsSchema = t.Object({
  powerOutputMWH: t.String({ example: "0.00608" }),
  electricityPricePerKWH: t.String({ example: "0.14" }),
  cashflowDiscount: t.Optional(t.String({ example: "0.1" })),
  latitude: t.String({ example: "36.00238522277973" }), // {example: "36.00238522277973"
  longitude: t.String({ example: "-115.19910714668856" }), // {example: "-115.19910714668856"}
  escalatorReference: t.Optional(t.String()),
});

type EstimateProtocolFeeArgsType = UnwrapSchema<
  typeof EstimateProtocolFeeArgsSchema
>;

export const protocolFeeRouter = new Elysia({ prefix: "/protocolFees" })
  .get(
    "/sunlightAndCertificates",
    async ({ query }) => {
      const parsedQuery = {
        latitude: Number(query.latitude),
        longitude: Number(query.longitude),
      };
      const sunlightHoursAndCertificates =
        await getSunlightHoursAndCertificates(parsedQuery);

      return sunlightHoursAndCertificates;
    },
    {
      query: LatitudeLongitudeQueryParamSchema,
      detail: {
        summary:
          "Gets the average sunlight and carbon certificates for a given latitude and longitude",
        description:
          "This route takes in a latitude and longitude and returns the average sunlight and carbon certificates",
        tags: [TAG.PROTOCOL_FEES],
      },
    }
  )
  .get(
    "/estimateFees",
    async ({ query, set }) => {
      const parsedQuery = {
        powerOutputMWH: parseFloat(query.powerOutputMWH),
        electricityPricePerKWH: parseFloat(query.electricityPricePerKWH),
        cashflowDiscount: query.cashflowDiscount
          ? parseFloat(query.cashflowDiscount)
          : protocolFeeAssumptions.cashflowDiscount,
        latitude: parseFloat(query.latitude),
        longitude: parseFloat(query.longitude),
        escalatorReference: query.escalatorReference
          ? parseFloat(query.escalatorReference)
          : undefined,
      };

      try {
        const { average_carbon_certificates, average_sunlight } =
          await getSunlightHoursAndCertificates({
            latitude: parsedQuery.latitude,
            longitude: parsedQuery.longitude,
          });

        const args: EstimateProtocolFeeArgs = {
          powerOutputMWH: parsedQuery.powerOutputMWH,
          hoursOfSunlightPerDay: average_sunlight,
          electricityPricePerKWH: parsedQuery.electricityPricePerKWH,
          cashflowDiscount: parsedQuery.cashflowDiscount,
          latitude: parsedQuery.latitude,
          longitude: parsedQuery.longitude,
          escalatorReference: parsedQuery.escalatorReference,
        };

        const estimatedProtocolFees = await estimateProtocolFees(args);

        const costPerWatt =
          estimatedProtocolFees.protocolFees / args.powerOutputMWH / 1e6; // 1e6 to convert from MWH to WH

        return {
          ...estimatedProtocolFees,
          protocolFeeAssumptions,
          costPerWatt,
          cashflowDiscount: parsedQuery.cashflowDiscount,
          referenceData: {
            averageCarbonCertificates: average_carbon_certificates,
            averageSunlight: average_sunlight,
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          console.error("[applicationsRouter] estimateFees", e);
          set.status = 400;
          return e.message;
        }
        console.error("[applicationsRouter] estimateFees", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: EstimateProtocolFeeArgsSchema,

      detail: {
        summary: "Estimate protocol fees",
        description:
          "Estimate protocol fees for a given latitude and longitude",
        tags: [TAG.PROTOCOL_FEES],
      },
    }
  )
  .get(
    "/detailedProductionAndDebt",
    async ({ query, set }) => {
      try {
        const latitude = parseFloat(query.latitude);
        const longitude = parseFloat(query.longitude);
        const powerOutputMWH = parseFloat(query.powerOutputMWH);

        if (isNaN(latitude) || isNaN(longitude) || isNaN(powerOutputMWH)) {
          set.status = 400;
          return { error: "Invalid latitude, longitude, or powerOutputMWH" };
        }

        // Get sunlight hours and carbon offset per MWh
        const { average_sunlight, average_carbon_certificates } =
          await getSunlightHoursAndCertificates({ latitude, longitude });

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
          totalCarbonDebtProduced *
          Math.pow(1 + disasterRisk, commitmentPeriod);
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
              formula: "from GVE API",
              variables: { latitude, longitude },
            },
            carbonOffsetsPerMWH: {
              value: average_carbon_certificates,
              formula: "from GVE API",
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
              formula:
                "adjustedTotalCarbonDebt / (weeksPerYear * commitmentPeriod)",
              variables: {
                adjustedTotalCarbonDebt,
                weeksPerYear,
                commitmentPeriod,
              },
            },
          },
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Unknown error occurred" };
      }
    },
    {
      query: t.Object({
        latitude: t.String({ example: "36.00238522277973" }),
        longitude: t.String({ example: "-115.19910714668856" }),
        powerOutputMWH: t.String({ example: "0.0064" }),
      }),
      detail: {
        summary:
          "Get detailed weekly production and carbon debt calculations (with formulas and constants)",
        description:
          "Returns all intermediate and final values for weekly production and carbon debt, including formulas and constants used for each calculation.",
        tags: [TAG.PROTOCOL_FEES],
      },
    }
  );
