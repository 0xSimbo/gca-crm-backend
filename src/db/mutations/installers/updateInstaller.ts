import { eq } from "drizzle-orm";
import { db } from "../../db";
import { InstallerUpdateType, installers } from "../../schema";

export const updateInstaller = async (
  data: InstallerUpdateType,
  installerId: string
) => {
  return await db
    .update(installers)
    .set(data)
    .where(eq(installers.id, installerId));
};
