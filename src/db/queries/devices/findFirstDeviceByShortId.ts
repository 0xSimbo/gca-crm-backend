import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findFirstDeviceById = async (id: string) => {
  const deviceDb = await db.query.farms.findFirst({
    where: eq(Devices.id, id),
  });
  return deviceDb;
};
