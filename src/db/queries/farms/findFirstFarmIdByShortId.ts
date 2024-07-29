import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Devices } from "../../schema";

export const findFirstFarmIdByShortId = async (shortId: string) => {
  const res = await db.query.Devices.findFirst({
    where: eq(Devices.shortId, shortId),
    with: {
      farm: {
        columns: {
          id: true,
        },
      },
    },
  });
  return res?.farm?.id;
};
