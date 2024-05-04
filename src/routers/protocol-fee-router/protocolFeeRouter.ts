import { Elysia, t, UnwrapSchema } from "elysia";
import { getRedisKey, setRedisKey } from "../../lib/redis-client";
import { TAG } from "../../constants";
import { getSunlightHoursAndCertificates } from "./utils/get-sunlight-hours-and-certificates";
import {
  estimateProtocolFees,
  EstimateProtocolFeeArgs,
  protocolFeeAssumptions,
} from "../../constants/protocol-fee-assumptions";
const LatitudeLongitudeQueryParamSchema = t.Object(
  {
    //takes a string, but parses it into a float
    latitude: t
      .Transform(t.String())
      .Decode((v) => parseFloat(v))
      .Encode(String),
    //takes a string, but parses it into a float
    longitude: t.Transform(t.String()).Decode(parseFloat).Encode(String),
  },

  {
    examples: [
      {
        latitude: "37.7749",
        longitude: "-122.4194",
      },
    ],
  }
);

// type EstimateProtocolFeeArgs = {
//   powerOutputMWH: number;
//   hoursOfSunlightPerDay: number;
//   electricityPricePerKWH: number;
//   cashflowDiscount: number;
//   latitude: number;
//   longitude: number;
// }

const EstimateProtocolFeeArgsSchema = t.Object(
  {
    powerOutputMWH: t.String({ example: "0.00608" }),
    electricityPricePerKWH: t.String({ example: "0.14" }),
    cashflowDiscount: t.Optional(t.String({ example: "0.1" })),
    latitude: t.String({ example: "36.00238522277973" }), // {example: "36.00238522277973"
    longitude: t.String({ example: "-115.19910714668856" }), // {example: "-115.19910714668856"}
  },
  {
    examples: [
      {
        powerOutputMWH: "0.00608",
        electricityPricePerKWH: "0.14",
        cashflowDiscount: "0.1",
        latitude: "36.00238522277973",
        longitude: "-115.19910714668856",
      },
    ],
  }
);

type EstimateProtocolFeeArgsType = UnwrapSchema<
  typeof EstimateProtocolFeeArgsSchema
>;

export const protocolFeeRouter = new Elysia({ prefix: "/protocolFees" })
  .get(
    "/sunlightAndCertificates",
    async ({ query }) => {
      const parsedQuery = {
        latitude: parseFloat(query.latitude),
        longitude: parseFloat(query.longitude),
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
    async ({ query }) => {
      const parsedQuery = {
        powerOutputMWH: parseFloat(query.powerOutputMWH),
        electricityPricePerKWH: parseFloat(query.electricityPricePerKWH),
        cashflowDiscount: query.cashflowDiscount
          ? parseFloat(query.cashflowDiscount)
          : protocolFeeAssumptions.cashflowDiscount,
        latitude: parseFloat(query.latitude),
        longitude: parseFloat(query.longitude),
      };

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
      };

      const estimatedProtocolFees = estimateProtocolFees(args);

      return {
        ...estimatedProtocolFees,
        protocolFeeAssumptions,
        cashflowDiscount: parsedQuery.cashflowDiscount,
      };
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
