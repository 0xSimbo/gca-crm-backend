// import { getRedisKey, setRedisKey } from "../../../lib/redis-client";
import { Coordinates } from "../../../types";

export const getSunlightHoursAndCertificates = async (query: Coordinates) => {
  //remove redis cache since api is not reliable
  // const redisKey = `sunlightAndCertificates-${query.latitude}-${query.longitude}`;
  // const cachedData = await getRedisKey<{
  //   average_sunlight: number;
  //   average_carbon_certificates: number;
  //   fallback: boolean;
  // }>(redisKey);
  // if (cachedData) {
  //   console.log("cached data = ", cachedData);
  //   return cachedData;
  // } else {
  try {
    const res = await fetch(
      `http://95.217.194.59:35015/api/v1/geo-stats?latitude=${query.latitude}&longitude=${query.longitude}`
    );
    const data = (await res.json()) as {
      average_sunlight: number;
      average_carbon_certificates: number;
    };
    console.log("data = ", data);
    // await setRedisKey(redisKey, JSON.stringify(data), 60);
    // console.log("not cached data", data);
    return {
      average_sunlight: data.average_sunlight,
      average_carbon_certificates: data.average_carbon_certificates,
      fallback: false,
    };
  } catch (error) {
    return {
      average_sunlight: 5.7153538630137275,
      average_carbon_certificates: 0.544651860894881,
      fallback: true,
    };
  }
  // }
};
