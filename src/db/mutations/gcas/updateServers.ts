import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Gcas } from "../../schema";

export const updateServers = async (gcaId: string, serverUrls: string[]) => {
  await db
    .update(Gcas)
    .set({
      serverUrls,
    })
    .where(eq(Gcas.id, gcaId));
  return serverUrls;
};
