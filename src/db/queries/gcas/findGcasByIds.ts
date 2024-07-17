import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { Gcas } from "../../schema";

export const findGcasByIds = async (ids: string[]) => {
  const gcasDb = await db.query.Gcas.findMany({
    columns: {
      id: true,
    },
    where: inArray(Gcas.id, ids),
  });
  return gcasDb;
};
