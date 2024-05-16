import { eq } from "drizzle-orm";
import { db } from "../../db";
import { installers } from "../../schema";

export const findFirstInstallerById = async (id: string) => {
  const installer = await db.query.installers.findFirst({
    where: eq(installers.id, id),
  });
  return installer;
};
