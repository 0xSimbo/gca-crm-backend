import { eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsByUserId = async (userId: string) => {
  const applicationsDb = await db.query.applications.findMany({
    where: eq(applications.userId, userId),
    columns: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      address: true,
      currentStep: true,
      roundRobinStatus: true,
      gcaAddress: true,
      installerCompanyName: true,
      installerEmail: true,
      installerPhone: true,
      installerName: true,
    },
    with: {
      user: {
        columns: {
          contactType: true,
          contactValue: true,
        },
      },
    },
  });
  return applicationsDb;
};
