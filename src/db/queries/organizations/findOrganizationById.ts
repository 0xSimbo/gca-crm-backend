import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Organizations } from "../../schema";

export const findOrganizationById = async (id: string) => {
  const organizationDb = await db.query.Organizations.findFirst({
    where: eq(Organizations.id, id),
    with: {
      owner: {
        columns: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
  return organizationDb;
};
