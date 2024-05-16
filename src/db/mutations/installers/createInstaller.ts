import { db } from "../../db";
import { InstallerInsertType, installers } from "../../schema";

export const createInstaller = async (installer: InstallerInsertType) => {
  const res = await db
    .insert(installers)
    .values(installer)
    .returning({ insertedId: installers.id });

  if (res.length === 0) {
    throw new Error("Failed to insert installer");
  }

  return res[0].insertedId;
};
