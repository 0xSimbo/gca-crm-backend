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
  );
