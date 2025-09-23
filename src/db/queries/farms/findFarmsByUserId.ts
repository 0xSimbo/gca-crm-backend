import { eq } from "drizzle-orm";
import { db } from "../../db";
import { farms } from "../../schema";

export const findFarmsByUserId = async (userId: string) => {
  const userFarms = await db.query.farms.findMany({
    where: eq(farms.userId, userId),
    columns: {
      id: true,
      name: true,
      region: true,
      regionFullName: true,
      createdAt: true,
      auditCompleteDate: true,
    },
    with: {
      devices: {
        columns: {
          id: true,
          shortId: true,
          publicKey: true,
          isEnabled: true,
          enabledAt: true,
          disabledAt: true,
        },
      },
      zone: {
        columns: {
          id: true,
          name: true,
        },
      },
      application: {
        columns: {
          id: true,
          status: true,
          currentStep: true,
        },
      },
    },
  });
  return userFarms;
};
