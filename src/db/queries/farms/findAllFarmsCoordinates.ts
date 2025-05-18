import { isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllFarmsCoordinates = async () => {
  const farmsCoordinates = await db.query.applications.findMany({
    columns: {
      lat: true,
      lng: true,
    },
    where: isNotNull(applications.farmId),
    with: {
      farm: {
        columns: {
          id: true,
          region: true,
          regionFullName: true,
          signalType: true,
        },
      },
    },
  });
  return farmsCoordinates.map((farm) => ({
    lat: farm.lat,
    lng: farm.lng,
    farmId: farm.farm?.id,
    region: farm.farm?.region,
    regionFullName: farm.farm?.regionFullName,
    signalType: farm.farm?.signalType,
  }));
};
