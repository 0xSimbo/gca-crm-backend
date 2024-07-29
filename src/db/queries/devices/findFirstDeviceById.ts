import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findFirstDeviceById = async (deviceId: string) => {
  return await db.query.Devices.findFirst({
    where: eq(Devices.id, deviceId),
  });
};
