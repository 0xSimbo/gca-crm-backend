import { getRedisKey, setRedisKey } from "../../../lib/redis-client";
import { Coordinates } from "../../../types";

export const getSunlightHoursAndCertificates = async (query: Coordinates) => {
  const redisKey = `sunlightAndCertificates-${query.latitude}-${query.longitude}`;
  const cachedData = await getRedisKey<{
    average_sunlight: number;
    average_carbon_certificates: number;
  }>(redisKey);
  if (cachedData) {
    console.log("cached data = ", cachedData);
    return cachedData;
  } else {
    const res = await fetch(
      `http://95.217.194.59:35015/api/v1/geo-stats?latitude=${query.latitude}&longitude=${query.longitude}`
    );
    const data = (await res.json()) as {
      average_sunlight: number;
      average_carbon_certificates: number;
    };
    await setRedisKey(redisKey, JSON.stringify(data), 60);
    console.log("not cached data", data);
    return data;
  }
};
