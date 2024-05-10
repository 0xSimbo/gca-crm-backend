import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Gcas } from "../../schema";

export const FindFirstGcaById = async (id: string) => {
  const gca = await db.query.Gcas.findFirst({
    where: eq(Gcas.id, id),
  });
  return gca;
};
