import { Elysia, t } from "elysia";
import { getRedisKey, setRedisKey } from "../../lib/redis-client";

const LatitudeLongitudeQueryParamSchema = t.Object({
  //takes a string, but parses it into a float
  latitude: t
    .Transform(t.String())
    .Decode((v) => parseFloat(v))
    .Encode(String),
  //takes a string, but parses it into a float
  longitude: t.Transform(t.String()).Decode(parseFloat).Encode(String),
});

export const protocolFeeRouter = new Elysia({ prefix: "/protocolFees" }).get(
  "/sunlightAndCertificates",
  async ({ query }) => {
    const redisKey = `sunlightAndCertificates-${query.latitude}-${query.longitude}`;
    const cachedData = await getRedisKey<{
      average_sunlight: number;
      average_carbon_certificates: number;
    }>(redisKey);
    if (cachedData) {
      return cachedData;
    } else {
      const res = await fetch(
        `http://95.217.194.59:35015/api/v1/geo-stats?latitude=${query.latitude}&longitude=${query.longitude}`,
      );
      const data = (await res.json()) as {
        average_sunlight: number;
        average_carbon_certificates: number;
      };
      await setRedisKey(redisKey, JSON.stringify(data), 60);
      return data;
    }
  },
  {
    query: LatitudeLongitudeQueryParamSchema,
    detail: {
      summary: "This is the summary of the route with query params",
      description:
        "This route takes in a latitude and longitude and returns the average sunlight and carbon certificates",
      tags: ["example", "example"],
    },
  },
);
