import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findFirstDeviceByShortId = async (shortId: string) => {
  return await db.query.Devices.findFirst({
    where: eq(Devices.shortId, shortId),
  });
};
