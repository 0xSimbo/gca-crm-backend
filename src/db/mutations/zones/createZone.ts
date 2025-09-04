import { db } from "../../db";
import { zones, ZoneInsert } from "../../schema";

export const createZone = async (
  zoneData: Omit<ZoneInsert, "id" | "createdAt">
) => {
  const [newZone] = await db.insert(zones).values(zoneData).returning();

  return newZone;
};
