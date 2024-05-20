import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findAllDevicesByFarmId = async (farmId: string) => {
  const devicesDb = await db.query.Devices.findMany({
    where: eq(Devices.farmId, farmId),
  });
  return devicesDb;
};
