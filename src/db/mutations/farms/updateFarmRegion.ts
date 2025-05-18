import { eq } from "drizzle-orm";
import { db } from "../../db";
import { farms } from "../../schema";

export const updateFarmRegion = async (
  farmId: string,
  region: {
    region: string;
    regionFullName: string;
    signalType: string;
  }
) => {
  await db
    .update(farms)
    .set({
      region: region.region,
      regionFullName: region.regionFullName,
      signalType: region.signalType,
    })
    .where(eq(farms.id, farmId));
};
