import { db } from "../../db";
import { GcaType, Gcas } from "../../schema";

export const createGca = async (gca: GcaType) => {
  await db.insert(Gcas).values(gca);
  return gca;
};
