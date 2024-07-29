import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findFirstDeviceByPublicKey = async (publicKey: string) => {
  return await db.query.Devices.findFirst({
    where: eq(Devices.publicKey, publicKey),
  });
};
