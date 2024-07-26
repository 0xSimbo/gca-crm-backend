import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";

export const findAllApplicationsOwnersByIds = async (ids: string[]) => {
  if (ids.length === 0) {
    return [];
  }
  return await db.query.applications.findMany({
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
};
