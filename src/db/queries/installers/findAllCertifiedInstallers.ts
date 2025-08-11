import { eq } from "drizzle-orm";
import { db } from "../../db";
import { installers } from "../../schema";

export const findAllCertifiedInstallers = async () => {
  return db.query.installers.findMany({
    where: eq(installers.isCertified, true),
    columns: {
      id: true,
      name: true,
      email: true,
      companyName: true,
      phone: true,
      isCertified: true,
      zoneIds: true,
    },
  });
};
