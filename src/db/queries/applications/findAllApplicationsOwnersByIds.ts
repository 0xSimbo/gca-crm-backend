import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsOwnersByIds = async (ids: string[]) => {
  const applicationDb = await db.query.applications.findMany({
    where: inArray(applications.id, ids),
    columns: {
      id: true,
    },
    with: {
      user: {
        columns: {
          id: true,
        },
      },
    },
  });

  return applicationDb;
};
