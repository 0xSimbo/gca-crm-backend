import { db } from "../../db";

export const findAllInstallers = async () => {
  return db.query.installers.findMany({
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
