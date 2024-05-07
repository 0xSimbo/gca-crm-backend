import { db } from "../../db";
import { gcaType, gcas } from "../../schema";

export const createGca = async (gca: gcaType) => {
  await db.insert(gcas).values(gca);
  return gca;
};
